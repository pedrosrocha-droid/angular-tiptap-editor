import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import tippy, { Instance as TippyInstance } from "tippy.js";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TableMap, columnIsHeader, rowIsHeader } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { AteEditorI18n } from "../../../services/ate-editor-i18n.service";
import { AteIconComponent } from "../../ui/ate-icon.component";
import { ATE_EFFECT_OPTIONS } from "../../../utils/ate-effect.utils";
import { AteTranslations } from "../../../i18n/ateTranslationsModel";
import {
  ATE_DEFAULT_CELL_MENU_CONFIG,
  ATE_DEFAULT_TABLE_MENU_CONFIG,
} from "../../../config/ate-editor.config";
import type {
  AteCellBubbleMenuConfig,
  AteTableBubbleMenuConfig,
  AteTableBubbleMenuKey,
} from "../../../models/ate-bubble-menu.model";
import {
  type AteTableCell,
  type AteTableCellsAction,
  type AteTableHandleAction,
  type AteTableHandleActionState,
  type AteTableHandleKind,
  type AteTableHandleTarget,
  runTableHandleAction,
  selectTableHandleTarget,
  selectionTableCell,
  tableCellAtDOM,
  tableHandleActionState,
  tableHandleSpan,
  tableRowPos,
} from "../../../extensions/ate-table-handles.extension";
import {
  type AteTableSortDirection,
  canSortTable,
  cellText,
  closeTableColumnMenu,
  columnFilterInfo,
  columnSortDirection,
  hasHeaderRow,
  openTableColumnMenu,
  spansRows,
  tableAt,
  toggleTableColumnMenu,
} from "../../../extensions/ate-table-sort.extension";

interface AteBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface AteHandlesLayout {
  table: AteBox;
  row: AteBox;
  column: AteBox;
  /** Every row or column the handle selects (merged cells stretch it): previews and `+` use it */
  rowBand: AteBox;
  columnBand: AteBox;
  /** The column handle and its `+` fit in the visible part of the table */
  columnShown: boolean;
  /** The top edge of the table is inside the editor viewport */
  topShown: boolean;
  /** The middle of the row under the pointer is inside the editor viewport */
  rowShown: boolean;
}

interface AteTableElements {
  wrapper: HTMLElement;
  table: HTMLTableElement;
}

interface AteTablePreview {
  kind: "remove" | "insert";
  band: "row" | "column" | "table";
  edge: "start" | "end";
}

interface AteHandleMenuItem {
  id: string;
  label: string;
  danger: boolean;
  separated: boolean;
  active: boolean;
  checked: boolean | null;
  disabled: boolean;
  reason: string | null;
  preview: AteTablePreview | null;
  run: () => void;
}

interface AteActionOptions {
  /** Why the item is disabled when a filter blocks it */
  filtered: string;
  preview?: AteTablePreview;
  danger?: boolean;
  checked?: boolean;
  keepOpen?: boolean;
}

type AteTableLabels = AteTranslations["table"];

interface AteMenuSettings {
  t: AteTableLabels;
  sort: boolean;
  filter: boolean;
  tableMenu: AteTableBubbleMenuConfig;
  cellMenu: AteCellBubbleMenuConfig;
}

const HIDE_DELAY = 250;

const CONTEXT_MENU_GRACE = 1000;

const NO_ACTION: AteTableHandleActionState = { enabled: false, blockedByFilter: false };

let nextId = 0;

function relativeBox(
  origin: DOMRect,
  left: number,
  top: number,
  right: number,
  bottom: number
): AteBox {
  return {
    left: left - origin.left,
    top: top - origin.top,
    width: right - left,
    height: bottom - top,
  };
}

function rowElement(view: EditorView, table: PMNode, tablePos: number, row: number) {
  const dom = view.nodeDOM(tableRowPos(table, tablePos, row));
  return dom instanceof HTMLElement ? dom : null;
}

/** The box of a column, from a cell that spans it alone when there is one */
function columnRect(view: EditorView, table: PMNode, tablePos: number, col: number) {
  const map = TableMap.get(table);
  let fallback: DOMRect | null = null;
  for (let row = 0; row < map.height; row++) {
    const offset = map.map[row * map.width + col];
    const dom = view.nodeDOM(tablePos + 1 + offset);
    const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
    if (!rect?.width) {
      continue;
    }
    if (map.colCount(offset) === col && Number(table.nodeAt(offset)?.attrs["colspan"] ?? 1) === 1) {
      return rect;
    }
    if (!fallback) {
      fallback = rect;
    }
  }
  return fallback;
}

function tableElements(view: EditorView, tablePos: number): AteTableElements | null {
  const dom = view.nodeDOM(tablePos);
  if (!(dom instanceof HTMLElement)) {
    return null;
  }
  const table = dom instanceof HTMLTableElement ? dom : dom.querySelector("table");
  return table ? { wrapper: dom, table } : null;
}

function rowsBox(view: EditorView, table: PMNode, tablePos: number, from: number, to: number) {
  let top = Infinity;
  let bottom = -Infinity;
  for (let row = from; row < to; row++) {
    const rect = rowElement(view, table, tablePos, row)?.getBoundingClientRect();
    if (rect?.height) {
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
  }
  return top < bottom ? { top, bottom } : null;
}

function columnsBox(view: EditorView, table: PMNode, tablePos: number, from: number, to: number) {
  const first = columnRect(view, table, tablePos, from);
  const last = columnRect(view, table, tablePos, to - 1);
  return first && last ? { left: first.left, right: last.right } : null;
}

function measureHandles(
  view: EditorView,
  cell: AteTableCell,
  origin: DOMRect,
  viewport: DOMRect | null
): AteHandlesLayout | null {
  const { state } = view;
  const table = tableAt(state.doc, cell.tablePos);
  const map = table ? TableMap.get(table) : null;
  const elements = tableElements(view, cell.tablePos);
  if (!table || !map || !elements || cell.row >= map.height || cell.col >= map.width) {
    return null;
  }
  const rowRect = rowElement(view, table, cell.tablePos, cell.row)?.getBoundingClientRect();
  const colRect = columnRect(view, table, cell.tablePos, cell.col);
  if (!rowRect?.height || !colRect) {
    return null;
  }
  const rows = tableHandleSpan(state, { kind: "row", tablePos: cell.tablePos, index: cell.row });
  const cols = tableHandleSpan(state, { kind: "column", tablePos: cell.tablePos, index: cell.col });
  const rowBand = (rows && rowsBox(view, table, cell.tablePos, rows.from, rows.to)) ?? rowRect;
  const columnBand =
    (cols && columnsBox(view, table, cell.tablePos, cols.from, cols.to)) ?? colRect;
  const tableRect = elements.table.getBoundingClientRect();
  const clip = elements.wrapper.getBoundingClientRect();
  const left = Math.max(tableRect.left, clip.left);
  const right = Math.min(tableRect.right, clip.right);
  const center = colRect.left + colRect.width / 2;
  const middle = rowRect.top + rowRect.height / 2;
  return {
    table: relativeBox(origin, left, tableRect.top, right, tableRect.bottom),
    row: relativeBox(origin, left, rowRect.top, right, rowRect.bottom),
    column: relativeBox(origin, colRect.left, tableRect.top, colRect.right, tableRect.bottom),
    rowBand: relativeBox(origin, left, rowBand.top, right, rowBand.bottom),
    columnBand: relativeBox(
      origin,
      columnBand.left,
      tableRect.top,
      columnBand.right,
      tableRect.bottom
    ),
    columnShown: center >= left && center <= right,
    topShown: !viewport || tableRect.top >= viewport.top,
    rowShown: !viewport || (middle >= viewport.top && middle <= viewport.bottom),
  };
}

function handleShown(kind: AteTableHandleKind, layout: AteHandlesLayout): boolean {
  switch (kind) {
    case "row":
      return layout.rowShown;
    case "column":
      return layout.topShown && layout.columnShown;
    default:
      return layout.topShown;
  }
}

function previewRect(preview: AteTablePreview, layout: AteHandlesLayout): AteBox {
  const band =
    preview.band === "row"
      ? layout.rowBand
      : preview.band === "column"
        ? layout.columnBand
        : layout.table;
  if (preview.kind === "remove") {
    return band;
  }
  if (preview.band === "column") {
    const x = preview.edge === "end" ? band.left + band.width : band.left;
    return { left: x - 1, top: band.top, width: 2, height: band.height };
  }
  const y = preview.edge === "end" ? band.top + band.height : band.top;
  return { left: band.left, top: y - 1, width: band.width, height: 2 };
}

/** Shift+F10 is also the browser's context menu key; some engines open it on keyup */
function suppressNextContextMenu() {
  const suppress = (event: Event) => event.preventDefault();
  const onKeyUp = () => setTimeout(release);
  const timeout = setTimeout(release, CONTEXT_MENU_GRACE);
  function release() {
    clearTimeout(timeout);
    document.removeEventListener("contextmenu", suppress, true);
    document.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", release);
  }
  document.addEventListener("contextmenu", suppress, { capture: true, once: true });
  document.addEventListener("keyup", onKeyUp, { once: true });
  window.addEventListener("blur", release, { once: true });
}

function sameCell(a: AteTableCell | null, b: AteTableCell | null): boolean {
  return a?.tablePos === b?.tablePos && a?.row === b?.row && a?.col === b?.col;
}

/**
 * Handles of the table under the pointer: one for the row and one for the column under it, one
 * for the table, and `+` between two handles. A handle selects its row or column and opens its
 * menu; the previews of its items are drawn here, outside the document.
 */
@Component({
  selector: "ate-table-handles",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AteIconComponent],
  host: {
    "(focusout)": "onFocusOut($event)",
  },
  template: `
    @if (layout(); as l) {
      @if (previewBox(); as box) {
        <div
          class="ate-table-preview"
          [class.is-remove]="preview()?.kind === 'remove'"
          [class.is-insert]="preview()?.kind === 'insert'"
          [attr.data-ate-table-preview]="preview()?.kind"
          [style.left.px]="box.left"
          [style.top.px]="box.top"
          [style.width.px]="box.width"
          [style.height.px]="box.height"></div>
      }
      @if (l.rowShown) {
        <button
          type="button"
          class="ate-table-handle is-row"
          data-ate-table-handle="row"
          aria-haspopup="menu"
          [attr.aria-expanded]="menu()?.kind === 'row'"
          [attr.aria-label]="rowLabel()"
          [attr.title]="rowLabel()"
          [style.left.px]="l.table.left - 7"
          [style.top.px]="l.row.top + l.row.height / 2 - 10"
          (mousedown)="$event.preventDefault()"
          (click)="toggleMenu('row')"
          (focus)="onHandleFocus()"
          (keydown)="onHandleKeyDown($event, 'row')">
          <ate-icon name="blockDrag" />
        </button>
      }
      @if (l.topShown && tableActions()) {
        <button
          type="button"
          class="ate-table-handle is-table"
          data-ate-table-handle="table"
          aria-haspopup="menu"
          [attr.aria-expanded]="menu()?.kind === 'table'"
          [attr.aria-label]="t().tableHandle"
          [attr.title]="t().tableHandle"
          [style.left.px]="l.table.left - 16"
          [style.top.px]="l.table.top - 16"
          (mousedown)="$event.preventDefault()"
          (click)="toggleMenu('table')"
          (focus)="onHandleFocus()"
          (keydown)="onHandleKeyDown($event, 'table')">
          <ate-icon name="blockDrag" />
        </button>
      }
      @if (l.topShown && l.columnShown) {
        <button
          type="button"
          class="ate-table-handle is-column"
          data-ate-table-handle="column"
          aria-haspopup="menu"
          [attr.aria-expanded]="menu()?.kind === 'column'"
          [attr.aria-label]="columnLabel()"
          [attr.title]="columnLabel()"
          [style.left.px]="l.column.left + l.column.width / 2 - 10"
          [style.top.px]="l.table.top - 7"
          (mousedown)="$event.preventDefault()"
          (click)="toggleMenu('column')"
          (focus)="onHandleFocus()"
          (keydown)="onHandleKeyDown($event, 'column')">
          <ate-icon name="blockDrag" />
        </button>
      }
      @if (l.rowShown && tableMenu().addRowAfter !== false) {
        <button
          type="button"
          class="ate-table-insert is-row"
          data-ate-table-insert="row"
          [class.is-disabled]="!rowGap().enabled"
          [attr.aria-disabled]="!rowGap().enabled || null"
          [attr.aria-label]="t().insertRow"
          [attr.aria-describedby]="rowGap().blockedByFilter ? gapReasonIds.row : null"
          [attr.title]="rowGap().blockedByFilter ? t().filteredHeader : t().insertRow"
          [style.left.px]="l.table.left - 8"
          [style.top.px]="l.rowBand.top + l.rowBand.height - 8"
          (mousedown)="$event.preventDefault()"
          (mouseenter)="showPreview(rowGap().enabled ? rowGapPreview : null)"
          (mouseleave)="hidePreview()"
          (focus)="onPreviewFocus($event, rowGap().enabled ? rowGapPreview : null)"
          (blur)="hidePreview()"
          (click)="insertInGap('row')">
          <ate-icon name="blockAdd" />
        </button>
      }
      @if (l.topShown && l.columnShown && tableMenu().addColumnAfter !== false) {
        <button
          type="button"
          class="ate-table-insert is-column"
          data-ate-table-insert="column"
          [class.is-disabled]="!columnGap().enabled"
          [attr.aria-disabled]="!columnGap().enabled || null"
          [attr.aria-label]="t().insertColumn"
          [attr.aria-describedby]="columnGap().blockedByFilter ? gapReasonIds.column : null"
          [attr.title]="columnGap().blockedByFilter ? t().filteredInsertColumn : t().insertColumn"
          [style.left.px]="l.columnBand.left + l.columnBand.width - 8"
          [style.top.px]="l.table.top - 8"
          (mousedown)="$event.preventDefault()"
          (mouseenter)="showPreview(columnGap().enabled ? columnGapPreview : null)"
          (mouseleave)="hidePreview()"
          (focus)="onPreviewFocus($event, columnGap().enabled ? columnGapPreview : null)"
          (blur)="hidePreview()"
          (click)="insertInGap('column')">
          <ate-icon name="blockAdd" />
        </button>
      }
    }
    <span hidden [id]="gapReasonIds.row">{{ t().filteredHeader }}</span>
    <span hidden [id]="gapReasonIds.column">{{ t().filteredInsertColumn }}</span>

    <div
      #menuRef
      class="ate-table-handle-menu"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="menuTitle()"
      (keydown)="onMenuKeyDown($event)"
      (focusout)="onFocusOut($event)"
      (mousedown)="$event.preventDefault()">
      <div class="ate-table-handle-menu-title" aria-hidden="true">{{ menuTitle() }}</div>
      @for (item of items(); track item.id) {
        @if (item.separated) {
          <div class="ate-table-handle-menu-separator" role="separator"></div>
        }
        <button
          type="button"
          class="ate-table-handle-menu-item"
          [attr.role]="item.checked === null ? 'menuitem' : 'menuitemcheckbox'"
          [attr.aria-checked]="item.checked"
          [attr.aria-disabled]="item.disabled || null"
          [attr.aria-label]="item.label"
          [attr.aria-describedby]="item.reason ? reasonId(item) : null"
          [attr.data-ate-table-menu-item]="item.id"
          [class.is-danger]="item.danger"
          [class.is-active]="item.active"
          [class.is-disabled]="item.disabled"
          (click)="activate(item)"
          (mouseenter)="showPreview(item.disabled ? null : item.preview)"
          (mouseleave)="hidePreview()"
          (focus)="onPreviewFocus($event, item.disabled ? null : item.preview)"
          (blur)="hidePreview()">
          <span class="ate-table-handle-menu-label">{{ item.label }}</span>
          @if (item.checked !== null) {
            <span
              class="ate-table-handle-menu-switch"
              [class.is-on]="item.checked"
              aria-hidden="true"></span>
          }
          @if (item.reason) {
            <span class="ate-table-handle-menu-reason" [id]="reasonId(item)">{{
              item.reason
            }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
      }

      .ate-table-handle,
      .ate-table-insert {
        position: absolute;
        display: grid;
        place-items: center;
        box-sizing: border-box;
        padding: 0;
        border: 1px solid var(--ate-table-handle-border-color);
        border-radius: 4px;
        background: var(--ate-table-handle-background);
        color: var(--ate-table-handle-color);
        cursor: pointer;
        pointer-events: auto;
      }

      .ate-table-handle .ate-icon,
      .ate-table-insert .ate-icon {
        font-size: 14px;
      }

      .ate-table-handle.is-row {
        width: 14px;
        height: 20px;
      }

      .ate-table-handle.is-column {
        width: 20px;
        height: 14px;
      }

      .ate-table-handle.is-column .ate-icon {
        transform: rotate(90deg);
      }

      .ate-table-handle.is-table {
        width: 14px;
        height: 14px;
      }

      .ate-table-insert {
        width: 16px;
        height: 16px;
        border-radius: 50%;
      }

      .ate-table-handle:hover,
      .ate-table-handle[aria-expanded="true"],
      .ate-table-insert:hover:not(.is-disabled) {
        border-color: var(--ate-table-handle-active-background);
        background: var(--ate-table-handle-active-background);
        color: var(--ate-table-handle-active-color);
      }

      .ate-table-insert.is-disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .ate-table-handle:focus-visible,
      .ate-table-insert:focus-visible {
        outline: 2px solid var(--ate-primary);
        outline-offset: 1px;
      }

      .ate-table-preview {
        position: absolute;
        pointer-events: none;
      }

      .ate-table-preview.is-remove {
        background: var(--ate-table-preview-remove-background);
        box-shadow: inset 0 0 0 1px var(--ate-table-preview-remove-border-color);
      }

      .ate-table-preview.is-insert {
        background: var(--ate-table-preview-insert-color);
      }

      .ate-table-handle-menu {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 200px;
        max-width: 280px;
        padding: var(--ate-menu-padding, 4px);
        background: var(--ate-menu-bg, #ffffff);
        border: 1px solid var(--ate-menu-border, rgba(0, 0, 0, 0.1));
        border-radius: var(--ate-menu-border-radius, 12px);
        box-shadow: var(--ate-menu-shadow, 0 8px 32px rgba(0, 0, 0, 0.12));
        color: var(--ate-text, #2d3748);
        font-size: 14px;
        outline: none;
      }

      .ate-table-handle-menu-title {
        padding: 4px 10px 2px;
        color: var(--ate-text-secondary, #64748b);
        font-size: 12px;
        font-weight: 600;
      }

      .ate-table-handle-menu-item {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        border-radius: var(--ate-sub-border-radius, 8px);
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .ate-table-handle-menu-item:hover:not(.is-disabled),
      .ate-table-handle-menu-item:focus-visible {
        background: var(--ate-surface-tertiary, #f1f5f9);
      }

      .ate-table-handle-menu-item:focus-visible {
        outline: 2px solid var(--ate-primary, #2563eb);
        outline-offset: -2px;
      }

      .ate-table-handle-menu-item.is-active {
        color: var(--ate-primary, #2563eb);
        font-weight: 600;
      }

      .ate-table-handle-menu-item.is-danger {
        color: var(--ate-error-color, #c53030);
      }

      .ate-table-handle-menu-item.is-danger:hover:not(.is-disabled) {
        background: var(--ate-table-preview-remove-background);
      }

      .ate-table-handle-menu-item.is-disabled {
        cursor: not-allowed;
      }

      .ate-table-handle-menu-item.is-disabled .ate-table-handle-menu-label {
        opacity: 0.5;
      }

      .ate-table-handle-menu-label {
        flex: 1;
      }

      .ate-table-handle-menu-reason {
        flex-basis: 100%;
        color: var(--ate-text-secondary, #64748b);
        font-size: 12px;
        font-weight: normal;
        white-space: normal;
      }

      .ate-table-handle-menu-switch {
        position: relative;
        width: 26px;
        height: 14px;
        border-radius: 7px;
        background: var(--ate-border, #e2e8f0);
      }

      .ate-table-handle-menu-switch::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--ate-surface, #ffffff);
      }

      .ate-table-handle-menu-switch.is-on {
        background: var(--ate-primary, #2563eb);
      }

      .ate-table-handle-menu-switch.is-on::after {
        left: 14px;
      }

      .ate-table-handle-menu-separator {
        height: 1px;
        margin: 4px 0;
        background: var(--ate-menu-border, rgba(0, 0, 0, 0.1));
      }
    `,
  ],
})
export class AteTableHandlesComponent implements AfterViewInit, OnDestroy {
  private readonly i18n = inject(AteEditorI18n);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly id = `ate-table-handles-${nextId++}`;

  readonly t = this.i18n.table;
  readonly gapReasonIds = {
    row: `${this.id}-insert-row-reason`,
    column: `${this.id}-insert-column-reason`,
  };

  editor = input.required<Editor>();
  enableSort = input(false);
  enableFilter = input(false);
  tableMenu = input<AteTableBubbleMenuConfig>(ATE_DEFAULT_TABLE_MENU_CONFIG);
  cellMenu = input<AteCellBubbleMenuConfig>(ATE_DEFAULT_CELL_MENU_CONFIG);

  /** The cell whose row and column show their handles */
  readonly hovered = signal<AteTableCell | null>(null);
  readonly layout = signal<AteHandlesLayout | null>(null);
  readonly menu = signal<AteTableHandleTarget | null>(null);
  readonly preview = signal<AteTablePreview | null>(null);
  private readonly version = signal(0);

  readonly rowGapPreview: AteTablePreview = { kind: "insert", band: "row", edge: "end" };
  readonly columnGapPreview: AteTablePreview = { kind: "insert", band: "column", edge: "end" };

  readonly rowLabel = computed(() => {
    const cell = this.hovered();
    return cell ? this.t().rowHandle.replace("{n}", String(cell.row + 1)) : "";
  });

  readonly columnLabel = computed(() => {
    this.version();
    const cell = this.hovered();
    const label = this.t().columnHandle;
    return cell ? label.replace("{name}", () => untracked(() => this.columnName(cell))) : "";
  });

  readonly menuTitle = computed(() => {
    switch (this.menu()?.kind) {
      case "row":
        return this.rowLabel();
      case "column":
        return this.columnLabel();
      case "table":
        return this.t().tableHandle;
      default:
        return "";
    }
  });

  readonly items = computed<AteHandleMenuItem[]>(() => {
    const target = this.menu();
    this.version();
    const settings: AteMenuSettings = {
      t: this.t(),
      sort: this.enableSort(),
      filter: this.enableFilter(),
      tableMenu: this.tableMenu(),
      cellMenu: this.cellMenu(),
    };
    return target ? untracked(() => this.menuItems(target, settings)) : [];
  });

  readonly tableActions = computed(() => {
    const { toggleHeaderRow, toggleHeaderColumn, deleteTable } = this.tableMenu();
    return toggleHeaderRow !== false || toggleHeaderColumn !== false || deleteTable !== false;
  });

  readonly rowGap = computed(() => this.gapState("row"));
  readonly columnGap = computed(() => this.gapState("column"));

  readonly previewBox = computed<AteBox | null>(() => {
    const preview = this.preview();
    const layout = this.layout();
    return preview && layout ? previewRect(preview, layout) : null;
  });

  private readonly menuRef = viewChild.required<ElementRef<HTMLDivElement>>("menuRef");
  private tippyInstance: TippyInstance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedTable: AteTableElements | null = null;
  private pointerInside = false;
  private lastCellElement: Element | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;
  private focusTimeout: ReturnType<typeof setTimeout> | null = null;
  private measureFrame: number | null = null;

  constructor() {
    effect(onCleanup => {
      const editor = this.editor();
      const onTransaction = ({ transaction }: { transaction: Transaction }) =>
        this.onTransaction(transaction);
      const onUpdate = () => this.onViewportChange();
      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(this.onViewportChange);
      resizeObserver?.observe(editor.view.dom);
      this.resizeObserver = resizeObserver;
      editor.on("transaction", onTransaction);
      editor.on("update", onUpdate);
      document.addEventListener("pointermove", this.onPointerMove, { passive: true });
      document.addEventListener("pointerout", this.onPointerOut, { passive: true });
      document.addEventListener("pointerdown", this.onPointerDown, true);
      document.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("scroll", this.onViewportChange, { capture: true, passive: true });
      window.addEventListener("resize", this.onViewportChange, { passive: true });
      onCleanup(() => {
        editor.off("transaction", onTransaction);
        editor.off("update", onUpdate);
        document.removeEventListener("pointermove", this.onPointerMove);
        document.removeEventListener("pointerout", this.onPointerOut);
        document.removeEventListener("pointerdown", this.onPointerDown, true);
        document.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("scroll", this.onViewportChange, { capture: true });
        window.removeEventListener("resize", this.onViewportChange);
        resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.observedTable = null;
        untracked(() => this.reset());
      });
    }, ATE_EFFECT_OPTIONS);
  }

  ngAfterViewInit() {
    this.tippyInstance = tippy(document.body, {
      content: this.menuRef().nativeElement,
      trigger: "manual",
      placement: "bottom-start",
      theme: "ate-bubble-menu",
      appendTo: () => (this.editor().options.element as HTMLElement) || document.body,
      interactive: true,
      hideOnClick: false,
      arrow: false,
      offset: [0, 6],
      getReferenceClientRect: () => this.menuAnchor(),
      popperOptions: {
        modifiers: [
          { name: "flip", options: { fallbackPlacements: ["top-start", "bottom-end", "top-end"] } },
        ],
      },
    });
  }

  ngOnDestroy() {
    this.clearTimers();
    this.tippyInstance?.destroy();
    this.tippyInstance = null;
  }

  reasonId(item: AteHandleMenuItem): string {
    return `${this.id}-${item.id}-reason`;
  }

  toggleMenu(kind: AteTableHandleKind) {
    const cell = this.hovered();
    if (!cell) {
      return;
    }
    if (this.menu()?.kind === kind) {
      this.closeMenu("editor");
      return;
    }
    const index = kind === "row" ? cell.row : kind === "column" ? cell.col : 0;
    this.openMenu({ kind, tablePos: cell.tablePos, index });
  }

  activate(item: AteHandleMenuItem) {
    if (!item.disabled) {
      item.run();
    }
  }

  showPreview(preview: AteTablePreview | null) {
    this.preview.set(preview);
  }

  hidePreview() {
    this.preview.set(null);
  }

  /** A focus from the keyboard previews like a hover; one set by the menu after a click does not */
  onPreviewFocus(event: FocusEvent, preview: AteTablePreview | null) {
    if (event.target instanceof Element && event.target.matches(":focus-visible")) {
      this.preview.set(preview);
    }
  }

  insertInGap(kind: "row" | "column") {
    const cell = this.hovered();
    if (cell) {
      const index = kind === "row" ? cell.row : cell.col;
      this.act({ kind, tablePos: cell.tablePos, index }, "insertAfter");
    }
  }

  onHandleFocus() {
    this.cancelHide();
  }

  onHandleKeyDown(event: KeyboardEvent, kind: AteTableHandleKind) {
    const cell = this.hovered();
    if (event.key === "Escape") {
      event.preventDefault();
      this.editor().commands.focus();
    } else if (
      kind === "row" &&
      cell &&
      (event.key === "Delete" || event.key === "Backspace") &&
      this.tableMenu().deleteRow !== false
    ) {
      event.preventDefault();
      this.act({ kind, tablePos: cell.tablePos, index: cell.row }, "delete");
    }
  }

  onMenuKeyDown(event: KeyboardEvent) {
    const target = this.menu();
    if (!target) {
      return;
    }
    const items = Array.from(
      this.menuRef().nativeElement.querySelectorAll<HTMLElement>(".ate-table-handle-menu-item")
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const from = index < 0 ? (step > 0 ? -1 : 0) : index;
        items[(from + step + items.length) % items.length]?.focus();
        break;
      }
      case "Home":
      case "End":
        event.preventDefault();
        (event.key === "Home" ? items[0] : items.at(-1))?.focus();
        break;
      case "Escape":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu("handle");
        break;
      case "Delete":
      case "Backspace":
        if (target.kind === "row" && this.tableMenu().deleteRow !== false) {
          event.preventDefault();
          this.act(target, "delete");
        }
        break;
    }
  }

  onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (!(next instanceof Node && this.owns(next)) && !this.pointerInside) {
      this.scheduleHide();
    }
  }

  private owns(node: Node): boolean {
    return this.host.nativeElement.contains(node) || this.menuRef().nativeElement.contains(node);
  }

  /** The handles stay while one of them or the menu has the focus */
  private focusInside(): boolean {
    const active = document.activeElement;
    return active instanceof Node && this.owns(active);
  }

  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "mouse") {
      this.trackPointer(event);
    }
  };

  /** Touch fires pointerout after every tap: only a mouse leaving the page hides the handles */
  private onPointerOut = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && !event.relatedTarget) {
      this.pointerInside = false;
      this.scheduleHide();
    }
  };

  private onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node && this.owns(target))) {
      this.closeMenu(null);
    }
    this.trackPointer(event);
  };

  private trackPointer(event: PointerEvent) {
    const editor = this.editor();
    if (editor.isDestroyed) {
      return;
    }
    const target = event.target;
    const cellElement = target instanceof Element ? target.closest("td, th") : null;
    const onTable = !!cellElement && editor.isEditable && editor.view.dom.contains(cellElement);
    const onHandles = target instanceof Node && this.host.nativeElement.contains(target);
    this.pointerInside = onTable || onHandles;
    if (this.menu() || this.filterMenuOpen()) {
      return;
    }
    if (!this.pointerInside) {
      this.lastCellElement = null;
      this.scheduleHide();
      return;
    }
    this.cancelHide();
    if (!cellElement || !onTable || cellElement === this.lastCellElement) {
      return;
    }
    const cell = this.cellAt(editor.view, cellElement, event);
    if (cell) {
      this.setHovered(cell);
    }
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "F10" || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const editor = this.editor();
    const target = event.target;
    if (
      editor.isDestroyed ||
      !editor.isEditable ||
      !(target instanceof Node) ||
      !editor.view.dom.contains(target)
    ) {
      return;
    }
    const cell = selectionTableCell(editor.state);
    if (!cell) {
      return;
    }
    event.preventDefault();
    suppressNextContextMenu();
    this.closeMenu(null);
    this.cancelHide();
    this.lastCellElement = null;
    this.setHovered(cell);
    this.focusLater(() => this.handleElement("row"));
  };

  private onViewportChange = () => {
    if (this.hovered()) {
      this.scheduleMeasure();
    }
  };

  private scheduleMeasure() {
    if (this.measureFrame === null) {
      this.measureFrame = requestAnimationFrame(() => {
        this.measureFrame = null;
        this.measure();
      });
    }
  }

  private onTransaction(tr: Transaction) {
    if (tr.docChanged) {
      this.lastCellElement = null;
      const hovered = this.hovered();
      const menu = this.menu();
      const hoveredPos = hovered && this.mapTable(tr, hovered.tablePos);
      const menuPos = menu && this.mapTable(tr, menu.tablePos);
      if (menu && menuPos === null) {
        this.closeMenu(null);
      } else if (menu && menuPos !== null && menuPos !== menu.tablePos) {
        this.menu.set({ ...menu, tablePos: menuPos });
      }
      if (hovered && hoveredPos === null) {
        this.hovered.set(null);
      } else if (hovered && hoveredPos !== null && hoveredPos !== hovered.tablePos) {
        this.hovered.set({ ...hovered, tablePos: hoveredPos });
      }
    }
    this.version.update(value => value + 1);
    if (this.hovered()) {
      this.scheduleMeasure();
    } else {
      this.measure();
    }
  }

  private mapTable(tr: Transaction, tablePos: number): number | null {
    const mapped = tr.mapping.mapResult(tablePos, 1);
    return mapped.deleted || !tableAt(tr.doc, mapped.pos) ? null : mapped.pos;
  }

  private cellAt(view: EditorView, element: Element, event: PointerEvent): AteTableCell | null {
    const cell = tableCellAtDOM(view, element);
    const table = cell && tableAt(view.state.doc, cell.tablePos);
    if (!cell || !table) {
      return null;
    }
    const map = TableMap.get(table);
    const node = table.nodeAt(map.map[cell.row * map.width + cell.col]);
    const rowspan = Number(node?.attrs["rowspan"] ?? 1);
    const colspan = Number(node?.attrs["colspan"] ?? 1);
    if (rowspan === 1 && colspan === 1) {
      this.lastCellElement = element;
    }
    let { row, col } = cell;
    for (let index = cell.row + 1; index < cell.row + rowspan; index++) {
      const rect = rowElement(view, table, cell.tablePos, index)?.getBoundingClientRect();
      if (rect?.height && event.clientY >= rect.top) {
        row = index;
      }
    }
    for (let index = cell.col + 1; index < cell.col + colspan; index++) {
      const rect = columnRect(view, table, cell.tablePos, index);
      if (rect && event.clientX >= rect.left) {
        col = index;
      }
    }
    return { tablePos: cell.tablePos, row, col };
  }

  private setHovered(cell: AteTableCell | null) {
    if (!sameCell(cell, this.hovered())) {
      this.hovered.set(cell);
      this.preview.set(null);
    }
    this.measure();
  }

  private gapState(kind: "row" | "column"): AteTableHandleActionState {
    this.version();
    const cell = this.hovered();
    if (!cell) {
      return NO_ACTION;
    }
    const target = { kind, tablePos: cell.tablePos, index: kind === "row" ? cell.row : cell.col };
    return untracked(() => tableHandleActionState(this.editor().state, target, "insertAfter"));
  }

  private measure() {
    const cell = this.hovered();
    const editor = this.editor();
    const viewport = editor.options.element as HTMLElement | null;
    const view = cell && !editor.isDestroyed && editor.isEditable ? editor.view : null;
    const layout =
      cell && view
        ? measureHandles(
            view,
            cell,
            this.host.nativeElement.getBoundingClientRect(),
            viewport?.getBoundingClientRect() ?? null
          )
        : null;
    this.layout.set(layout);
    this.observeTable(cell && view ? tableElements(view, cell.tablePos) : null);
    const menu = this.menu();
    if (menu && !(layout && handleShown(menu.kind, layout))) {
      this.closeMenu(this.focusInside() ? "editor" : null);
    }
    if (!layout) {
      this.preview.set(null);
    }
    this.tippyInstance?.popperInstance?.update();
  }

  /** Column resizing and images loading move the handles without a transaction or a scroll */
  private observeTable(elements: AteTableElements | null) {
    if (elements?.table === this.observedTable?.table) {
      return;
    }
    if (this.observedTable) {
      this.resizeObserver?.unobserve(this.observedTable.wrapper);
      this.resizeObserver?.unobserve(this.observedTable.table);
    }
    if (elements) {
      this.resizeObserver?.observe(elements.wrapper);
      this.resizeObserver?.observe(elements.table);
    }
    this.observedTable = elements;
  }

  private scheduleHide() {
    if (this.hideTimeout !== null || !this.hovered()) {
      return;
    }
    this.hideTimeout = setTimeout(() => {
      this.hideTimeout = null;
      if (!this.menu() && !this.focusInside() && !this.pointerInside && !this.filterMenuOpen()) {
        this.lastCellElement = null;
        this.setHovered(null);
      }
    }, HIDE_DELAY);
  }

  private cancelHide() {
    if (this.hideTimeout !== null) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  private filterMenuOpen(): boolean {
    const editor = this.editor();
    return !editor.isDestroyed && !!openTableColumnMenu(editor.state);
  }

  private handleElement(kind: AteTableHandleKind): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`[data-ate-table-handle="${kind}"]`);
  }

  private focusLater(element: () => HTMLElement | null) {
    if (this.focusTimeout !== null) {
      clearTimeout(this.focusTimeout);
    }
    this.focusTimeout = setTimeout(() => {
      this.focusTimeout = null;
      this.tippyInstance?.popperInstance?.update();
      element()?.focus({ preventScroll: true });
    });
  }

  private openMenu(target: AteTableHandleTarget) {
    const { view } = this.editor();
    this.cancelHide();
    closeTableColumnMenu(view);
    this.menu.set(target);
    this.preview.set(null);
    selectTableHandleTarget(view, target);
    if (this.menu() !== target) {
      return;
    }
    this.tippyInstance?.show();
    this.focusLater(() => {
      const items = Array.from(
        this.menuRef().nativeElement.querySelectorAll<HTMLElement>(".ate-table-handle-menu-item")
      );
      return items.find(item => !item.classList.contains("is-disabled")) ?? items[0] ?? null;
    });
  }

  private closeMenu(focus: "handle" | "editor" | null) {
    const target = this.menu();
    if (!target) {
      return;
    }
    this.menu.set(null);
    this.preview.set(null);
    this.tippyInstance?.hide();
    const editor = this.editor();
    if (focus === "handle") {
      this.handleElement(target.kind)?.focus({ preventScroll: true });
    } else if (focus === "editor" && !editor.isDestroyed) {
      editor.view.focus();
    }
  }

  private menuAnchor(): DOMRect {
    const target = this.menu();
    const handle = target ? this.handleElement(target.kind) : null;
    const layout = this.layout();
    if (!target || !handle) {
      return new DOMRect(-9999, -9999, 0, 0);
    }
    const rect = handle.getBoundingClientRect();
    if (target.kind !== "row" || !layout) {
      return rect;
    }
    const origin = this.host.nativeElement.getBoundingClientRect();
    return new DOMRect(
      rect.left,
      origin.top + layout.rowBand.top,
      rect.width,
      layout.rowBand.height
    );
  }

  private act(target: AteTableHandleTarget, action: AteTableHandleAction) {
    const { view } = this.editor();
    if (!tableHandleActionState(view.state, target, action).enabled) {
      return;
    }
    this.closeMenu(null);
    runTableHandleAction(view, target, action);
    view.focus();
  }

  private toggle(target: AteTableHandleTarget, action: AteTableHandleAction) {
    runTableHandleAction(this.editor().view, target, action);
  }

  private sort(target: AteTableHandleTarget, dir: AteTableSortDirection) {
    this.closeMenu(null);
    this.editor().chain().focus().sortTableColumn(target.index, dir, target.tablePos).run();
  }

  private openFilter(target: AteTableHandleTarget) {
    this.lastCellElement = null;
    this.setHovered({ tablePos: target.tablePos, row: 0, col: target.index });
    this.closeMenu("handle");
    toggleTableColumnMenu(this.editor().view, { tablePos: target.tablePos, col: target.index });
  }

  private columnName(cell: AteTableCell): string {
    const table = tableAt(this.editor().state.doc, cell.tablePos);
    const text =
      table && hasHeaderRow(table) ? cellText(table, TableMap.get(table), 0, cell.col) : "";
    return text || String(cell.col + 1);
  }

  private actionItem(
    state: EditorState,
    target: AteTableHandleTarget,
    id: string,
    label: string,
    action: AteTableHandleAction,
    options: AteActionOptions
  ): AteHandleMenuItem {
    const { enabled, blockedByFilter } = tableHandleActionState(state, target, action);
    return {
      id,
      label,
      danger: !!options.danger,
      separated: false,
      active: false,
      checked: options.checked ?? null,
      disabled: !enabled,
      reason: blockedByFilter ? options.filtered : null,
      preview: options.preview ?? null,
      run: () => (options.keepOpen ? this.toggle(target, action) : this.act(target, action)),
    };
  }

  private menuItems(target: AteTableHandleTarget, settings: AteMenuSettings): AteHandleMenuItem[] {
    const { state } = this.editor();
    const table = tableAt(state.doc, target.tablePos);
    if (!table) {
      return [];
    }
    const { t, tableMenu } = settings;
    const item = (
      key: AteTableBubbleMenuKey,
      id: string,
      label: string,
      action: AteTableHandleAction,
      options: AteActionOptions
    ) =>
      tableMenu[key] === false ? [] : [this.actionItem(state, target, id, label, action, options)];
    let groups: AteHandleMenuItem[][];
    if (target.kind === "row") {
      groups = [
        [
          ...item("addRowBefore", "insertAbove", t.insertAbove, "insertBefore", {
            filtered: t.filteredHeader,
            preview: { kind: "insert", band: "row", edge: "start" },
          }),
          ...item("addRowAfter", "insertBelow", t.insertBelow, "insertAfter", {
            filtered: t.filteredHeader,
            preview: { kind: "insert", band: "row", edge: "end" },
          }),
        ],
        this.cellsItems(state, target, settings),
        item("deleteRow", "deleteRow", t.deleteRow, "delete", {
          filtered: t.filteredHeader,
          preview: { kind: "remove", band: "row", edge: "start" },
          danger: true,
        }),
      ];
    } else if (target.kind === "table") {
      const map = TableMap.get(table);
      groups = [
        [
          ...item("toggleHeaderRow", "headerRow", t.headerRow, "toggleHeaderRow", {
            filtered: t.filteredHeader,
            checked: rowIsHeader(map, table, 0),
            keepOpen: true,
          }),
          ...item("toggleHeaderColumn", "headerColumn", t.headerColumn, "toggleHeaderColumn", {
            filtered: t.filteredHeader,
            checked: columnIsHeader(map, table, 0),
            keepOpen: true,
          }),
        ],
        item("deleteTable", "deleteTable", t.deleteTable, "delete", {
          filtered: t.filteredDeleteTable,
          preview: { kind: "remove", band: "table", edge: "start" },
          danger: true,
        }),
      ];
    } else {
      groups = [
        this.sortFilterItems(state, table, target, settings),
        [
          ...item("addColumnBefore", "insertLeft", t.insertLeft, "insertBefore", {
            filtered: t.filteredInsertColumn,
            preview: { kind: "insert", band: "column", edge: "start" },
          }),
          ...item("addColumnAfter", "insertRight", t.insertRight, "insertAfter", {
            filtered: t.filteredInsertColumn,
            preview: { kind: "insert", band: "column", edge: "end" },
          }),
        ],
        this.cellsItems(state, target, settings),
        item("deleteColumn", "deleteColumn", t.deleteColumn, "delete", {
          filtered: t.filteredDeleteColumn,
          preview: { kind: "remove", band: "column", edge: "start" },
          danger: true,
        }),
      ];
    }
    return groups
      .filter(group => group.length > 0)
      .flatMap((group, index) =>
        group.map((entry, position) => ({ ...entry, separated: index > 0 && position === 0 }))
      );
  }

  /** Merge cells and Split cell, when they apply to what the handle selects */
  private cellsItems(
    state: EditorState,
    target: AteTableHandleTarget,
    { t, cellMenu }: AteMenuSettings
  ): AteHandleMenuItem[] {
    const actions: [AteTableCellsAction, string][] = [
      ["mergeCells", t.mergeCells],
      ["splitCell", t.splitCell],
    ];
    return actions.flatMap(([action, label]) => {
      if (cellMenu[action] === false) {
        return [];
      }
      const entry = this.actionItem(state, target, action, label, action, {
        filtered: t.filteredCells,
      });
      return entry.disabled && !entry.reason ? [] : [entry];
    });
  }

  private sortFilterItems(
    state: EditorState,
    table: PMNode,
    target: AteTableHandleTarget,
    { t, sort, filter }: AteMenuSettings
  ): AteHandleMenuItem[] {
    if (!hasHeaderRow(table)) {
      return [];
    }
    const sortable = canSortTable(table);
    const merged = spansRows(table);
    const base = { danger: false, separated: false, checked: null, preview: null };
    const items: AteHandleMenuItem[] = [];
    if (sort) {
      const current = columnSortDirection(state, target.tablePos, target.index);
      const options: [string, string, AteTableSortDirection][] = [
        ["sortAscending", t.sortAscending, "asc"],
        ["sortDescending", t.sortDescending, "desc"],
      ];
      for (const [id, label, dir] of options) {
        items.push({
          ...base,
          id,
          label,
          active: current === dir,
          disabled: !sortable,
          reason: !sortable && merged ? t.sortMergedCells : null,
          run: () => this.sort(target, dir),
        });
      }
    }
    if (filter) {
      const info = columnFilterInfo(state, { tablePos: target.tablePos, col: target.index });
      items.push({
        ...base,
        id: "filter",
        label: t.filterColumn,
        active: !!info?.filter,
        disabled: !sortable,
        reason: !sortable && merged ? t.filterMergedCells : null,
        run: () => this.openFilter(target),
      });
    }
    return items;
  }

  private clearTimers() {
    this.cancelHide();
    if (this.focusTimeout !== null) {
      clearTimeout(this.focusTimeout);
      this.focusTimeout = null;
    }
    if (this.measureFrame !== null) {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
  }

  private reset() {
    this.clearTimers();
    this.pointerInside = false;
    this.lastCellElement = null;
    this.menu.set(null);
    this.preview.set(null);
    this.hovered.set(null);
    this.layout.set(null);
    this.tippyInstance?.hide();
  }
}
