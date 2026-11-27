import { ChangeDetectionStrategy, Component, computed } from "@angular/core";
import { CellSelection } from "@tiptap/pm/tables";
import { AteButtonComponent } from "../../ui/ate-button.component";
import { AteCellBubbleMenuComponent } from "./ate-cell-bubble-menu.component";
import {
  type AteTableCellsAction,
  type AteTableHandleActionState,
  isTableColumnSelection,
  tableCellsActionState,
} from "../../../extensions/ate-table-handles.extension";

let nextId = 0;

/** Merge and split buttons on a cell range that is not a whole row or column (table handles) */
@Component({
  selector: "ate-table-range-bar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AteButtonComponent],
  template: `
    <div #menuRef class="bubble-menu ate-table-range-bar" (mousedown)="$event.preventDefault()">
      @if (cellBubbleMenuConfig().mergeCells) {
        <ate-button
          icon="mergeCells"
          [title]="i18n().table().mergeCells"
          [disabled]="!merge().enabled"
          [describedBy]="merge().blockedByFilter ? reasonId : null"
          (buttonClick)="onCommand('mergeCells', $event)"></ate-button>
      }
      @if (cellBubbleMenuConfig().splitCell) {
        <ate-button
          icon="splitCell"
          [title]="i18n().table().splitCell"
          [disabled]="!split().enabled"
          [describedBy]="split().blockedByFilter ? reasonId : null"
          (buttonClick)="onCommand('splitCell', $event)"></ate-button>
      }
      @if (blockedByFilter()) {
        <span class="ate-table-range-bar-reason" [id]="reasonId">{{
          i18n().table().filteredCells
        }}</span>
      }
    </div>
  `,
  styles: [
    `
      .ate-table-range-bar {
        flex-wrap: wrap;
        max-width: 260px;
      }

      .ate-table-range-bar-reason {
        flex-basis: 100%;
        padding: 2px 6px 4px;
        color: var(--ate-text-secondary, #64748b);
        font-size: 12px;
        white-space: normal;
      }
    `,
  ],
})
export class AteTableRangeBarComponent extends AteCellBubbleMenuComponent {
  readonly reasonId = `ate-table-range-bar-${nextId++}-reason`;

  readonly merge = computed(() => this.cellsState("mergeCells"));
  readonly split = computed(() => this.cellsState("splitCell"));
  readonly blockedByFilter = computed(() => {
    const { mergeCells, splitCell } = this.cellBubbleMenuConfig();
    return (
      (mergeCells && this.merge().blockedByFilter) || (splitCell && this.split().blockedByFilter)
    );
  });

  override shouldShow(): boolean {
    const { state } = this.editor();
    const { mergeCells, splitCell } = this.cellBubbleMenuConfig();
    return (
      super.shouldShow() &&
      (mergeCells || splitCell) &&
      state.selection instanceof CellSelection &&
      !state.selection.isRowSelection() &&
      !isTableColumnSelection(state)
    );
  }

  private cellsState(action: AteTableCellsAction): AteTableHandleActionState {
    this.state();
    const editor = this.editor();
    return editor.isDestroyed
      ? { enabled: false, blockedByFilter: false }
      : tableCellsActionState(editor.state, action);
  }
}
