import { Extension } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  addColumn,
  addRow,
  cellAround,
  columnIsHeader,
  removeColumn,
  removeRow,
  rowIsHeader,
  tableNodeTypes,
  type TableRect,
} from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { protectsHiddenRows } from "../utils/ate-table-hidden-rows.utils";
import { selectionTouchesHiddenRows, tableAt, tableHiddenRows } from "./ate-table-sort.extension";

export type AteTableHandleKind = "row" | "column" | "table";

/** A row or a column of a table (`index` from 0), or the whole table */
export interface AteTableHandleTarget {
  kind: AteTableHandleKind;
  tablePos: number;
  index: number;
}

/** A cell of a table, by its first row and column */
export interface AteTableCell {
  tablePos: number;
  row: number;
  col: number;
}

/**
 * Changes made from a handle: insert before or after a row or a column, delete it (the table
 * for the table handle), or toggle the header row or column of the table
 */
export type AteTableHandleAction =
  | "insertBefore"
  | "insertAfter"
  | "delete"
  | "toggleHeaderRow"
  | "toggleHeaderColumn";

export interface AteTableHandleActionState {
  enabled: boolean;
  /** The action would change rows a filter hides */
  blockedByFilter: boolean;
}

export interface AteTableHandlesOptions {
  /** Whether Delete and Backspace remove the rows of a selection covering whole rows */
  enabled: () => boolean;
}

function wholeTable(table: PMNode, tablePos: number): TableRect {
  const map = TableMap.get(table);
  return {
    map,
    table,
    tableStart: tablePos + 1,
    left: 0,
    top: 0,
    right: map.width,
    bottom: map.height,
  };
}

export function tableCellPos(table: PMNode, tablePos: number, row: number, col: number): number {
  const map = TableMap.get(table);
  return tablePos + 1 + map.map[row * map.width + col];
}

export function tableRowPos(table: PMNode, tablePos: number, row: number): number {
  let pos = tablePos + 1;
  for (let index = 0; index < row; index++) {
    pos += table.child(index).nodeSize;
  }
  return pos;
}

function cellOf($cell: ResolvedPos | null): AteTableCell | null {
  if (!$cell) {
    return null;
  }
  const tablePos = $cell.before(-1);
  const rect = TableMap.get($cell.node(-1)).findCell($cell.pos - tablePos - 1);
  return { tablePos, row: rect.top, col: rect.left };
}

export function selectionTableCell(state: EditorState): AteTableCell | null {
  const { selection } = state;
  return cellOf(
    selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head)
  );
}

export function tableCellAtDOM(view: EditorView, element: Node): AteTableCell | null {
  let pos: number;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  return cellOf(cellAround(view.state.doc.resolve(pos)));
}

function cursorAt(tr: Transaction, tablePos: number, row: number, col: number): Transaction {
  const table = tableAt(tr.doc, tablePos);
  if (!table) {
    return tr;
  }
  const map = TableMap.get(table);
  const cell = tableCellPos(
    table,
    tablePos,
    Math.max(0, Math.min(row, map.height - 1)),
    Math.max(0, Math.min(col, map.width - 1))
  );
  return tr.setSelection(Selection.near(tr.doc.resolve(cell + 1)));
}

/** Same cells as prosemirror-tables' toggleHeader, for a table the selection may be outside of */
function toggleHeader(tr: Transaction, table: PMNode, tablePos: number, type: "row" | "column") {
  const map = TableMap.get(table);
  const types = tableNodeTypes(table.type.schema);
  const rowOn = rowIsHeader(map, table, 0);
  const columnOn = columnIsHeader(map, table, 0);
  const skipCorner = (type === "row" ? columnOn : rowOn) ? 1 : 0;
  const cells =
    type === "row"
      ? { left: skipCorner, top: 0, right: map.width, bottom: 1 }
      : { left: 0, top: skipCorner, right: 1, bottom: map.height };
  const cellType = (type === "row" ? rowOn : columnOn) ? types.cell : types.header_cell;
  map.cellsInRect(cells).forEach(offset => {
    const pos = tablePos + 1 + offset;
    const cell = tr.doc.nodeAt(pos);
    if (cell) {
      tr.setNodeMarkup(pos, cellType, cell.attrs);
    }
  });
  return tr;
}

function rowTransaction(
  state: EditorState,
  table: PMNode,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): Transaction | null {
  const rect = wholeTable(table, target.tablePos);
  const { height } = rect.map;
  if (target.index < 0 || target.index >= height) {
    return null;
  }
  if (action === "insertBefore" || action === "insertAfter") {
    const row = action === "insertBefore" ? target.index : target.index + 1;
    return cursorAt(addRow(state.tr, rect, row), target.tablePos, row, 0);
  }
  if (action === "delete" && height > 1) {
    const tr = state.tr;
    removeRow(tr, rect, target.index);
    return cursorAt(tr, target.tablePos, rowAfterRemoval(state, target, height), 0);
  }
  return null;
}

/** Index, after the removal, of a row the filter shows: a cursor left in a hidden row shows it */
function rowAfterRemoval(state: EditorState, target: AteTableHandleTarget, height: number) {
  const hidden = tableHiddenRows(state).get(target.tablePos);
  for (let row = target.index + 1; row < height; row++) {
    if (!hidden?.has(row)) {
      return row - 1;
    }
  }
  for (let row = target.index - 1; row > 0; row--) {
    if (!hidden?.has(row)) {
      return row;
    }
  }
  return 0;
}

function columnTransaction(
  state: EditorState,
  table: PMNode,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): Transaction | null {
  const rect = wholeTable(table, target.tablePos);
  const { width } = rect.map;
  if (target.index < 0 || target.index >= width) {
    return null;
  }
  if (action === "insertBefore" || action === "insertAfter") {
    const col = action === "insertBefore" ? target.index : target.index + 1;
    return cursorAt(addColumn(state.tr, rect, col), target.tablePos, 0, col);
  }
  if (action === "delete" && width > 1) {
    const tr = state.tr;
    removeColumn(tr, rect, target.index);
    return cursorAt(tr, target.tablePos, 0, Math.min(target.index, width - 2));
  }
  return null;
}

/** The transaction a handle action makes, or null when it cannot apply to the target */
export function tableHandleTransaction(
  state: EditorState,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): Transaction | null {
  const table = tableAt(state.doc, target.tablePos);
  if (!table) {
    return null;
  }
  switch (target.kind) {
    case "row":
      return rowTransaction(state, table, target, action);
    case "column":
      return columnTransaction(state, table, target, action);
    default:
      if (action === "delete") {
        return state.tr.delete(target.tablePos, target.tablePos + table.nodeSize);
      }
      if (action === "toggleHeaderRow" || action === "toggleHeaderColumn") {
        const type = action === "toggleHeaderRow" ? "row" : "column";
        return toggleHeader(state.tr, table, target.tablePos, type);
      }
      return null;
  }
}

/**
 * Whether a handle action can run. A filter blocks it the way it blocks any transaction that
 * would alter the rows it hides, the selection set aside: the action runs from a visible cell.
 */
export function tableHandleActionState(
  state: EditorState,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): AteTableHandleActionState {
  const tr = tableHandleTransaction(state, target, action);
  if (!tr) {
    return { enabled: false, blockedByFilter: false };
  }
  const blockedByFilter = !protectsHiddenRows(tr, state, tableHiddenRows(state), false);
  return { enabled: !blockedByFilter, blockedByFilter };
}

export function runTableHandleAction(
  view: EditorView,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): boolean {
  const table = tableAt(view.state.doc, target.tablePos);
  if (!view.editable || !table || !tableHandleActionState(view.state, target, action).enabled) {
    return false;
  }
  if (selectionTouchesHiddenRows(view.state)) {
    const row = target.kind === "row" ? target.index : 0;
    const col = target.kind === "column" ? target.index : 0;
    view.dispatch(cursorAt(view.state.tr, target.tablePos, row, col));
  }
  const tr = tableHandleTransaction(view.state, target, action);
  if (!tr) {
    return false;
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function selectTableHandleTarget(view: EditorView, target: AteTableHandleTarget): void {
  const { state } = view;
  const table = tableAt(state.doc, target.tablePos);
  if (!table || target.kind === "table") {
    return;
  }
  const map = TableMap.get(table);
  const size = target.kind === "row" ? map.height : map.width;
  if (target.index < 0 || target.index >= size) {
    return;
  }
  const cell = (row: number, col: number) =>
    state.doc.resolve(tableCellPos(table, target.tablePos, row, col));
  if (target.kind === "row") {
    const selection = CellSelection.rowSelection(
      cell(target.index, 0),
      cell(target.index, map.width - 1)
    );
    view.dispatch(state.tr.setSelection(selection));
    return;
  }
  const hidden = tableHiddenRows(state).get(target.tablePos);
  let last = map.height - 1;
  while (last > 0 && hidden?.has(last)) {
    last--;
  }
  // Not CellSelection.colSelection: it always ends in the last row, which a filter would then show
  view.dispatch(
    state.tr.setSelection(new CellSelection(cell(0, target.index), cell(last, target.index)))
  );
}

/**
 * Table handles: Delete and Backspace remove the rows of a selection covering whole rows (a row
 * selected from its handle or by dragging across it). The handles and their menus are drawn by
 * `ate-table-handles`, outside the document.
 */
export const AteTableHandles = Extension.create<AteTableHandlesOptions>({
  name: "ateTableHandles",

  // After the filter's Delete (selection over hidden rows), before the table's (empties cells)
  priority: 900,

  addOptions() {
    return {
      enabled: () => true,
    };
  },

  addKeyboardShortcuts() {
    const deleteRows = () => {
      const { editor } = this;
      const { selection } = editor.state;
      if (
        !this.options.enabled() ||
        !editor.isEditable ||
        !(selection instanceof CellSelection) ||
        !selection.isRowSelection() ||
        selectionTouchesHiddenRows(editor.state)
      ) {
        return false;
      }
      return editor.commands.deleteRow();
    };
    return {
      Backspace: deleteRows,
      "Mod-Backspace": deleteRows,
      Delete: deleteRows,
      "Mod-Delete": deleteRows,
    };
  },
});
