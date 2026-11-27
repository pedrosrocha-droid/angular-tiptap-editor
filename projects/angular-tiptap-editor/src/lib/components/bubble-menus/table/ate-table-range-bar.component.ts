import { ChangeDetectionStrategy, Component } from "@angular/core";
import { CellSelection } from "@tiptap/pm/tables";
import { AteButtonComponent } from "../../ui/ate-button.component";
import { AteCellBubbleMenuComponent } from "./ate-cell-bubble-menu.component";

/** Merge and split buttons on a cell range that is not a whole row or column (table handles) */
@Component({
  selector: "ate-table-range-bar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AteButtonComponent],
  template: `
    <div #menuRef class="bubble-menu" (mousedown)="$event.preventDefault()">
      @if (cellBubbleMenuConfig().mergeCells) {
        <ate-button
          icon="mergeCells"
          [title]="i18n().table().mergeCells"
          [disabled]="!state().can.mergeCells"
          (buttonClick)="onCommand('mergeCells', $event)"></ate-button>
      }
      @if (cellBubbleMenuConfig().splitCell) {
        <ate-button
          icon="splitCell"
          [title]="i18n().table().splitCell"
          [disabled]="!state().can.splitCell"
          (buttonClick)="onCommand('splitCell', $event)"></ate-button>
      }
    </div>
  `,
})
export class AteTableRangeBarComponent extends AteCellBubbleMenuComponent {
  override shouldShow(): boolean {
    const { selection } = this.editor().state;
    const { mergeCells, splitCell } = this.cellBubbleMenuConfig();
    return (
      super.shouldShow() &&
      (mergeCells || splitCell) &&
      selection instanceof CellSelection &&
      !selection.isRowSelection() &&
      !selection.isColSelection()
    );
  }
}
