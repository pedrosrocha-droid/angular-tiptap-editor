import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { EditorState, Selection, type Transaction } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  addColumn,
  addRow,
  cellAround,
  columnIsHeader,
  mergeCells,
  removeColumn,
  removeRow,
  rowIsHeader,
  splitCell,
  tableNodeTypes,
  type TableRect,
} from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { protectsHiddenRows } from "../utils/ate-table-hidden-rows.utils";
import {
  canSortTable,
  pinTableRows,
  rowsShownBySelection,
  selectionTouchesHiddenRows,
  tableAt,
  tableHasHiddenRows,
  tableHiddenRows,
} from "./ate-table-sort.extension";

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

/** Rows (row handle) or columns (column handle) a handle selects, from `from` to `to` excluded */
export interface AteTableSpan {
  from: number;
  to: number;
}

export type AteTableCellsAction = "mergeCells" | "splitCell";

/**
 * Changes made from a handle: insert before or after a row or a column, delete it (the table
 * for the table handle), toggle the header row or column of the table, or merge or split the
 * cells the handle selects
 */
export type AteTableHandleAction =
  | "insertBefore"
  | "insertAfter"
  | "delete"
  | "toggleHeaderRow"
  | "toggleHeaderColumn"
  | AteTableCellsAction;

export interface AteTableHandleActionState {
  enabled: boolean;
  /** The action would change rows a filter hides, or drop the filters of the table */
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

function cellSelectionRect(selection: CellSelection) {
  const tableStart = selection.$anchorCell.start(-1);
  const map = TableMap.get(selection.$anchorCell.node(-1));
  const rect = map.rectBetween(
    selection.$anchorCell.pos - tableStart,
    selection.$headCell.pos - tableStart
  );
  return { ...rect, map, tablePos: tableStart - 1 };
}

/** Whether the selection covers whole columns, the rows a filter hides below it aside */
export function isTableColumnSelection(state: EditorState): boolean {
  const { selection } = state;
  if (!(selection instanceof CellSelection)) {
    return false;
  }
  if (selection.isColSelection()) {
    return true;
  }
  const { top, bottom, map, tablePos } = cellSelectionRect(selection);
  const hidden = tableHiddenRows(state).get(tablePos);
  if (top > 0 || !hidden?.size) {
    return false;
  }
  for (let row = bottom; row < map.height; row++) {
    if (!hidden.has(row)) {
      return false;
    }
  }
  return true;
}

function handleSelection(state: EditorState, target: AteTableHandleTarget): CellSelection | null {
  const table = tableAt(state.doc, target.tablePos);
  if (!table || target.kind === "table") {
    return null;
  }
  const map = TableMap.get(table);
  const size = target.kind === "row" ? map.height : map.width;
  if (target.index < 0 || target.index >= size) {
    return null;
  }
  const cell = (row: number, col: number) =>
    state.doc.resolve(tableCellPos(table, target.tablePos, row, col));
  if (target.kind === "row") {
    return CellSelection.rowSelection(cell(target.index, 0), cell(target.index, map.width - 1));
  }
  const hidden = tableHiddenRows(state).get(target.tablePos);
  let last = map.height - 1;
  while (last > 0 && hidden?.has(last)) {
    last--;
  }
  // Not CellSelection.colSelection: it always ends in the last row, which a filter would then show
  return new CellSelection(cell(0, target.index), cell(last, target.index));
}

/** The rows or columns a handle selects, more than one when merged cells stretch the selection */
export function tableHandleSpan(
  state: EditorState,
  target: AteTableHandleTarget
): AteTableSpan | null {
  const selection = handleSelection(state, target);
  if (!selection) {
    return null;
  }
  const rect = cellSelectionRect(selection);
  return target.kind === "row"
    ? { from: rect.top, to: rect.bottom }
    : { from: rect.left, to: rect.right };
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
  const span = tableHandleSpan(state, target);
  if (!span) {
    return null;
  }
  const { height } = TableMap.get(table);
  if (action === "insertBefore" || action === "insertAfter") {
    const row = action === "insertBefore" ? span.from : span.to;
    const tr = addRow(state.tr, wholeTable(table, target.tablePos), row);
    const grown = tableAt(tr.doc, target.tablePos);
    if (grown) {
      pinTableRows(tr, [tableRowPos(grown, target.tablePos, row)]);
    }
    return cursorAt(tr, target.tablePos, row, 0);
  }
  if (action === "delete" && span.to - span.from < height) {
    const tr = state.tr;
    for (let row = span.to - 1; row >= span.from; row--) {
      const current = tableAt(tr.doc, target.tablePos);
      if (current) {
        removeRow(tr, wholeTable(current, target.tablePos), row);
      }
    }
    const next = rowAfterRemoval(state, target.tablePos, span, height);
    return cursorAt(tr, target.tablePos, next, 0);
  }
  return null;
}

/** Index, after the removal, of a row the filter shows: a cursor left in a hidden row shows it */
function rowAfterRemoval(state: EditorState, tablePos: number, span: AteTableSpan, height: number) {
  const hidden = tableHiddenRows(state).get(tablePos);
  for (let row = span.to; row < height; row++) {
    if (!hidden?.has(row)) {
      return row - (span.to - span.from);
    }
  }
  for (let row = span.from - 1; row > 0; row--) {
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
  const span = tableHandleSpan(state, target);
  if (!span) {
    return null;
  }
  const { width } = TableMap.get(table);
  if (action === "insertBefore" || action === "insertAfter") {
    const col = action === "insertBefore" ? span.from : span.to;
    const tr = addColumn(state.tr, wholeTable(table, target.tablePos), col);
    return cursorAt(tr, target.tablePos, 0, col);
  }
  if (action === "delete" && span.to - span.from < width) {
    const tr = state.tr;
    for (let col = span.to - 1; col >= span.from; col--) {
      const current = tableAt(tr.doc, target.tablePos);
      if (current) {
        removeColumn(tr, wholeTable(current, target.tablePos), col);
      }
    }
    const left = width - (span.to - span.from);
    return cursorAt(tr, target.tablePos, 0, Math.min(span.from, left - 1));
  }
  return null;
}

function cellsCommandTransaction(
  state: EditorState,
  action: AteTableCellsAction
): Transaction | null {
  let result: Transaction | null = null;
  const command = action === "mergeCells" ? mergeCells : splitCell;
  command(state, tr => {
    result = tr;
  });
  return result;
}

function cellsTransaction(
  state: EditorState,
  target: AteTableHandleTarget,
  action: AteTableCellsAction
): Transaction | null {
  const selection = handleSelection(state, target);
  if (!selection) {
    return null;
  }
  const source = state.selection.eq(selection)
    ? state
    : EditorState.create({ doc: state.doc, selection });
  return cellsCommandTransaction(source, action);
}

function isCellsAction(action: AteTableHandleAction): action is AteTableCellsAction {
  return action === "mergeCells" || action === "splitCell";
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
  if (isCellsAction(action)) {
    return cellsTransaction(state, target, action);
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

/** Whether a table with hidden rows keeps its filters: the same width and no cell spanning rows */
function keepsFilters(tr: Transaction, state: EditorState, tablePos: number): boolean {
  const before = tableAt(state.doc, tablePos);
  if (!before || !tableHasHiddenRows(state, tablePos)) {
    return true;
  }
  const mapped = tr.mapping.mapResult(tablePos, 1);
  const after = mapped.deleted ? null : tableAt(tr.doc, mapped.pos);
  return (
    !after || (TableMap.get(after).width === TableMap.get(before).width && canSortTable(after))
  );
}

function filterState(
  tr: Transaction | null,
  state: EditorState,
  tablePos: number,
  strict?: boolean
): AteTableHandleActionState {
  if (!tr) {
    return { enabled: false, blockedByFilter: false };
  }
  const blockedByFilter =
    !protectsHiddenRows(tr, state, tableHiddenRows(state), strict) ||
    !keepsFilters(tr, state, tablePos);
  return { enabled: !blockedByFilter, blockedByFilter };
}

/**
 * Whether a handle action can run. A filter blocks it the way it blocks any transaction that
 * would alter the rows it hides, the selection set aside (the action runs from a visible cell),
 * and blocks what would drop the filters: changing the width or spanning rows.
 */
export function tableHandleActionState(
  state: EditorState,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): AteTableHandleActionState {
  return filterState(tableHandleTransaction(state, target, action), state, target.tablePos, false);
}

/** Whether Merge cells or Split cell can run on the selection, and whether a filter blocks them */
export function tableCellsActionState(
  state: EditorState,
  action: AteTableCellsAction
): AteTableHandleActionState {
  const cell = selectionTableCell(state);
  const tr = cell ? cellsCommandTransaction(state, action) : null;
  return filterState(tr, state, cell?.tablePos ?? -1);
}

export function runTableHandleAction(
  view: EditorView,
  target: AteTableHandleTarget,
  action: AteTableHandleAction
): boolean {
  if (!view.editable || !tableHandleActionState(view.state, target, action).enabled) {
    return false;
  }
  const selection = isCellsAction(action) ? handleSelection(view.state, target) : null;
  if (selection) {
    if (!view.state.selection.eq(selection)) {
      view.dispatch(view.state.tr.setSelection(selection));
    }
  } else if (selectionTouchesHiddenRows(view.state)) {
    const row = target.kind === "row" ? target.index : 0;
    const col = target.kind === "column" ? target.index : 0;
    view.dispatch(cursorAt(view.state.tr, target.tablePos, row, col));
  }
  const tr = tableHandleTransaction(view.state, target, action);
  if (!tr) {
    return false;
  }
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** Selects the row or column of a handle; rows only the current selection kept shown stay shown */
export function selectTableHandleTarget(view: EditorView, target: AteTableHandleTarget): void {
  const { state } = view;
  const selection = handleSelection(state, target);
  const table = tableAt(state.doc, target.tablePos);
  if (!selection || !table) {
    return;
  }
  const shown = rowsShownBySelection(state, target.tablePos);
  const tr = pinTableRows(
    state.tr.setSelection(selection),
    shown.map(row => tableRowPos(table, target.tablePos, row))
  );
  view.dispatch(tr);
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
