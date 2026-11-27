import { test, expect, type Locator, type Page } from "@playwright/test";
import { clearEditor, expectMenuClosed } from "./helpers";

type DebugNode = {
  type: { name: string };
  descendants: (fn: (node: DebugNode, pos: number) => boolean | void) => void;
};

type DebugPlugin = {
  key: string;
  getState: (state: unknown) => { pinned: readonly number[] } | undefined;
};

type DebugEditor = {
  state: { doc: DebugNode; selection: Record<string, unknown>; plugins: DebugPlugin[] };
  setEditable: (editable: boolean) => void;
  getHTML: () => string;
  on: (event: string, handler: () => void) => void;
  commands: {
    setContent: (content: string) => boolean;
    setTableColumnFilter: (column: number, filter: unknown, tablePos?: number) => boolean;
  };
};

type DebugWindow = Window & {
  ng?: {
    getComponent: (element: Element) => { getEditor: () => DebugEditor | null };
    getOwningComponent: (element: Element) => { editorConfig: () => Record<string, unknown> };
    applyChanges: (component: unknown) => void;
  };
};

/** Runs `run` in the page with the demo editor; `run` must only use its arguments */
async function withEditor<T, A>(page: Page, run: (editor: DebugEditor, arg: A) => T, arg: A) {
  return page.evaluate(
    ({ source, value }) => {
      const host = document.querySelector("angular-tiptap-editor")!;
      const editor = (window as DebugWindow).ng!.getComponent(host).getEditor()!;
      return new Function("editor", "arg", `return (${source})(editor, arg);`)(editor, value) as T;
    },
    { source: run.toString(), value: arg }
  );
}

function tableHtml(header: string[], rows: string[][]) {
  const head = `<tr>${header.map(cell => `<th><p>${cell}</p></th>`).join("")}</tr>`;
  const body = rows
    .map(row => `<tr>${row.map(cell => `<td><p>${cell}</p></td>`).join("")}</tr>`)
    .join("");
  return `<table><tbody>${head}${body}</tbody></table>`;
}

const PEOPLE = tableHtml(
  ["Name", "City", "Amount"],
  [
    ["Ann", "Paris", "10"],
    ["Bob", "Lyon", "25"],
    ["Cid", "Paris", "7"],
    ["Dan", "Nice", "40"],
  ]
);

const NO_HEADER =
  "<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>";

const MERGED =
  "<table><tbody>" +
  "<tr><th><p>H1</p></th><th><p>H2</p></th><th><p>H3</p></th></tr>" +
  '<tr><td rowspan="2"><p>A</p></td><td><p>b1</p></td><td><p>c1</p></td></tr>' +
  "<tr><td><p>b2</p></td><td><p>c2</p></td></tr>" +
  '<tr><td colspan="2"><p>D</p></td><td><p>d3</p></td></tr>' +
  "</tbody></table>";

async function setContent(page: Page, html: string) {
  await withEditor(page, (editor, content) => editor.commands.setContent(content), html);
}

async function setConfig(page: Page, overrides: Record<string, unknown>) {
  await page.evaluate(extra => {
    const win = window as DebugWindow;
    const host = document.querySelector("angular-tiptap-editor")!;
    const app = win.ng!.getOwningComponent(host);
    const nextConfig = { ...app.editorConfig(), ...extra };
    app.editorConfig = () => nextConfig;
    win.ng!.applyChanges(app);
  }, overrides);
}

async function setInput(page: Page, name: string, value: unknown) {
  await page.evaluate(
    ({ inputName, inputValue }) => {
      const win = window as DebugWindow;
      const host = document.querySelector("angular-tiptap-editor")!;
      const component = win.ng!.getComponent(host) as unknown as Record<string, object>;
      const input = component[inputName] as Record<symbol, unknown>;
      const key = Object.getOwnPropertySymbols(input).find(item => item.description === "SIGNAL")!;
      const node = input[key] as { applyValueToInputSignal: (n: unknown, v: unknown) => void };
      node.applyValueToInputSignal(node, inputValue);
      win.ng!.applyChanges(win.ng!.getOwningComponent(host));
    },
    { inputName: name, inputValue: value }
  );
}

/** Filters a column of the first table from code */
async function filterColumn(page: Page, column: number, filter: unknown) {
  return withEditor(
    page,
    (editor, { col, value }) => {
      let tablePos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (tablePos < 0 && node.type.name === "table") {
          tablePos = pos;
        }
        return tablePos < 0;
      });
      return editor.commands.setTableColumnFilter(col, value, tablePos);
    },
    { col: column, value: filter }
  );
}

const editorHtml = (page: Page) => withEditor(page, editor => editor.getHTML(), null);

const isCellSelection = (page: Page) =>
  withEditor(page, editor => "$anchorCell" in editor.state.selection, null);

const pinnedRows = (page: Page) =>
  withEditor(
    page,
    editor => {
      const plugin = editor.state.plugins.find(item => item.key.startsWith("ateTableSort$"));
      return plugin?.getState(editor.state)?.pinned.length ?? -1;
    },
    null
  );

function cell(page: Page, row: number, column: number) {
  return page.locator(`.ProseMirror table tr:nth-child(${row + 1}) > :nth-child(${column + 1})`);
}

function column(page: Page, index: number) {
  return page.locator(`.ProseMirror table tr > :nth-child(${index + 1})`);
}

function cellWithText(page: Page, text: string) {
  return page
    .locator(".ProseMirror td, .ProseMirror th")
    .filter({ hasText: new RegExp(`^${text}$`) });
}

const rows = (page: Page) => page.locator(".ProseMirror table tr");
const headerCells = (page: Page) => page.locator(".ProseMirror table tr:first-child > *");
const hiddenRows = (page: Page) => page.locator(".ProseMirror table tr[data-ate-table-hidden]");
const visibleColumn = (page: Page, index: number) =>
  page.locator(
    `.ProseMirror table tr:not(:first-child):not([data-ate-table-hidden]) > :nth-child(${index + 1})`
  );

const rowHandle = (page: Page) => page.locator('[data-ate-table-handle="row"]');
const columnHandle = (page: Page) => page.locator('[data-ate-table-handle="column"]');
const tableHandle = (page: Page) => page.locator('[data-ate-table-handle="table"]');
const anyHandle = (page: Page) => page.locator("[data-ate-table-handle], [data-ate-table-insert]");
const insertButton = (page: Page, kind: "row" | "column") =>
  page.locator(`[data-ate-table-insert="${kind}"]`);
const preview = (page: Page, kind: "remove" | "insert") =>
  page.locator(`[data-ate-table-preview="${kind}"]`);

async function openMenu(page: Page, handle: Locator, name: string) {
  await handle.click();
  const menu = page.getByRole("menu", { name, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Selects the cells from `from` to `to` ([row, column]) with a click and a Shift+click */
async function selectCells(page: Page, from: [number, number], to: [number, number]) {
  await cell(page, ...from).click();
  await cell(page, ...to).click({ modifiers: ["Shift"] });
  await expect.poll(() => isCellSelection(page)).toBe(true);
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

const HANDLES = { enableTableHandles: true };

const HEADER_REASON = "With a filter on, the header does not change: clear the filters.";

const INSERT_COLUMN_REASON = "With a filter on, no column can be inserted: clear the filters.";

const CELLS_REASON = "With a filter on, these cells cannot be merged or split: clear the filters.";

test.describe("Table handles", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".ate-editor")).toBeVisible();
    await clearEditor(page);
  });

  test("is opt-in: without it the table and cell bubble menus and the header buttons stay", async ({
    page,
  }) => {
    await setConfig(page, { enableTableSort: true });
    await setContent(page, PEOPLE);

    await cell(page, 1, 0).click();
    await expect(page.getByRole("button", { name: "Add row before" })).toBeVisible();
    await expect(anyHandle(page)).toHaveCount(0);
    await expect(page.locator(".ProseMirror .ate-table-column-button")).toHaveCount(3);
    await selectCells(page, [1, 0], [2, 1]);
    await expect(page.getByRole("button", { name: "Merge cells" })).toBeVisible();

    await setConfig(page, { enableTableHandles: true });
    await expect(page.locator("ate-table-bubble-menu, ate-cell-bubble-menu")).toHaveCount(0);
    await cell(page, 2, 1).click();
    await expect(page.getByRole("button", { name: "Add row before" })).toHaveCount(0);
    await expect(page.locator(".ProseMirror .ate-table-column-button")).toHaveCount(0);
    await expect(rowHandle(page)).toBeVisible();

    await setConfig(page, { enableTableHandles: false });
    await expect(page.locator(".ProseMirror .ate-table-column-button")).toHaveCount(3);
    await expect(anyHandle(page)).toHaveCount(0);
    await cell(page, 1, 0).click();
    await expect(page.getByRole("button", { name: "Add row before" })).toBeVisible();
  });

  test("clicking a cell to type opens no menu", async ({ page }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);

    await cell(page, 2, 1).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");

    await expect(cell(page, 2, 1)).toHaveText("Lyonx");
    expect(await isCellSelection(page)).toBe(false);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add row before" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Merge cells" })).toHaveCount(0);
  });

  test("shows the handles of the row and the column under the pointer and of the table, out of the document", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    const html = await editorHtml(page);

    await cell(page, 2, 1).hover();
    await expect(rowHandle(page)).toHaveAccessibleName("Row 3");
    await expect(columnHandle(page)).toHaveAccessibleName("Column City");
    await expect(tableHandle(page)).toHaveAccessibleName("Table");

    const row = await box(rows(page).nth(2));
    const rowGrip = await box(rowHandle(page));
    expect(Math.abs(rowGrip.y + rowGrip.height / 2 - (row.y + row.height / 2))).toBeLessThan(2);
    const city = await box(cell(page, 2, 1));
    const columnGrip = await box(columnHandle(page));
    expect(Math.abs(columnGrip.x + columnGrip.width / 2 - (city.x + city.width / 2))).toBeLessThan(
      2
    );

    await expect(page.locator(".ProseMirror [data-ate-table-handle]")).toHaveCount(0);
    expect(await editorHtml(page)).toBe(html);

    await cell(page, 1, 2).hover();
    await expect(rowHandle(page)).toHaveAccessibleName("Row 2");
    await expect(columnHandle(page)).toHaveAccessibleName("Column Amount");

    await page.mouse.move(2, 2);
    await expect(anyHandle(page)).toHaveCount(0);
  });

  test("the row handle selects the row and inserts above and below", async ({ page }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);

    await cell(page, 2, 0).hover();
    let menu = await openMenu(page, rowHandle(page), "Row 3");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Insert above",
      "Insert below",
      "Merge cells",
      "Delete row",
    ]);
    await expect(menu.getByRole("separator")).toHaveCount(2);
    await expect(menu.getByRole("menuitem", { name: "Delete row" })).toHaveClass(/is-danger/);
    await expect(rowHandle(page)).toHaveAttribute("aria-expanded", "true");
    expect(await isCellSelection(page)).toBe(true);
    await expect(page.locator(".ProseMirror .selectedCell")).toHaveCount(3);
    await expect(rows(page).nth(2).locator(".selectedCell")).toHaveCount(3);

    await menu.getByRole("menuitem", { name: "Insert above" }).click();
    await expectMenuClosed(menu);
    await expect(column(page, 0)).toHaveText(["Name", "Ann", "", "Bob", "Cid", "Dan"]);

    await cell(page, 3, 0).hover();
    menu = await openMenu(page, rowHandle(page), "Row 4");
    await menu.getByRole("menuitem", { name: "Insert below" }).click();
    await expect(column(page, 0)).toHaveText(["Name", "Ann", "", "Bob", "", "Cid", "Dan"]);
    await page.keyboard.type("New");
    await expect(cell(page, 4, 0)).toHaveText("New");
  });

  test("deletes a row from its menu, with Delete from the menu, and with Backspace on a whole selected row", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);

    await cell(page, 1, 0).hover();
    let menu = await openMenu(page, rowHandle(page), "Row 2");
    await menu.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(column(page, 0)).toHaveText(["Name", "Bob", "Cid", "Dan"]);

    await cell(page, 1, 0).hover();
    menu = await openMenu(page, rowHandle(page), "Row 2");
    await expect(menu.getByRole("menuitem", { name: "Insert above" })).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(column(page, 0)).toHaveText(["Name", "Cid", "Dan"]);

    await selectCells(page, [1, 0], [1, 2]);
    await page.keyboard.press("Backspace");
    await expect(column(page, 0)).toHaveText(["Name", "Dan"]);
  });

  test("one undo takes back a handle action alone, not the typing right before it", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);

    await cell(page, 1, 0).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await expect(cell(page, 1, 0)).toHaveText("Annx");

    const menu = await openMenu(page, rowHandle(page), "Row 2");
    await menu.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(column(page, 0)).toHaveText(["Name", "Bob", "Cid", "Dan"]);

    await page.keyboard.press("ControlOrMeta+z");
    await expect(column(page, 0)).toHaveText(["Name", "Annx", "Bob", "Cid", "Dan"]);
  });

  test("the column handle selects the column and sorts, inserts and deletes", async ({ page }) => {
    await setConfig(page, { ...HANDLES, enableTableSort: true, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await expect(page.locator(".ProseMirror .ate-table-column-button")).toHaveCount(0);

    await cell(page, 1, 1).hover();
    let menu = await openMenu(page, columnHandle(page), "Column City");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Sort ascending",
      "Sort descending",
      "Filter…",
      "Insert left",
      "Insert right",
      "Merge cells",
      "Delete column",
    ]);
    await expect(menu.getByRole("menuitem", { name: "Delete column" })).toHaveClass(/is-danger/);
    await expect(page.locator(".ProseMirror .selectedCell")).toHaveCount(5);
    await expect(page.locator(".ProseMirror tr > .selectedCell:nth-child(2)")).toHaveCount(5);

    await menu.getByRole("menuitem", { name: "Sort ascending" }).click();
    await expect(column(page, 1)).toHaveText(["City", "Lyon", "Nice", "Paris", "Paris"]);
    await expect(headerCells(page).nth(1)).toHaveAttribute("aria-sort", "ascending");
    await expect(page.locator(".ProseMirror .ate-table-column-button")).toHaveCount(0);

    await cell(page, 1, 1).hover();
    menu = await openMenu(page, columnHandle(page), "Column City");
    await menu.getByRole("menuitem", { name: "Insert left" }).click();
    await expect(headerCells(page)).toHaveText(["Name", "", "City", "Amount"]);
    await expect(page.locator(".ProseMirror table tr:first-child > th")).toHaveCount(4);

    await cell(page, 1, 2).hover();
    menu = await openMenu(page, columnHandle(page), "Column City");
    await menu.getByRole("menuitem", { name: "Insert right" }).click();
    await expect(headerCells(page)).toHaveText(["Name", "", "City", "", "Amount"]);

    await cell(page, 1, 2).hover();
    menu = await openMenu(page, columnHandle(page), "Column City");
    await menu.getByRole("menuitem", { name: "Delete column" }).click();
    await expect(headerCells(page)).toHaveText(["Name", "", "", "Amount"]);
  });

  test("the column menu offers sorting and filtering only when enabled and the table has a header row", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    await cell(page, 1, 1).hover();
    let menu = await openMenu(page, columnHandle(page), "Column City");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Insert left",
      "Insert right",
      "Merge cells",
      "Delete column",
    ]);
    await page.keyboard.press("Escape");

    await setConfig(page, { enableTableFilter: true });
    menu = await openMenu(page, columnHandle(page), "Column City");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Filter…",
      "Insert left",
      "Insert right",
      "Merge cells",
      "Delete column",
    ]);
    await page.keyboard.press("Escape");

    await setConfig(page, { enableTableSort: true });
    await setContent(page, NO_HEADER);
    await cell(page, 1, 1).hover();
    menu = await openMenu(page, columnHandle(page), "Column 2");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Insert left",
      "Insert right",
      "Merge cells",
      "Delete column",
    ]);
  });

  test("Filter… opens the filter of the column and gives the focus back to its handle", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableSort: true, enableTableFilter: true });
    await setContent(page, PEOPLE);

    await cell(page, 1, 1).hover();
    const menu = await openMenu(page, columnHandle(page), "Column City");
    await menu.getByRole("menuitem", { name: "Filter…" }).click();

    const dialog = page.getByRole("dialog", { name: "Column menu: City" });
    await expect(dialog.getByRole("group", { name: "Filter" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sort ascending" })).toHaveCount(0);
    await dialog.getByRole("checkbox", { name: /^Lyon/ }).uncheck();
    await dialog.getByRole("checkbox", { name: /^Nice/ }).uncheck();
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "Cid"]);

    await page.keyboard.press("Escape");
    await expectMenuClosed(dialog);
    await expect(columnHandle(page)).toBeFocused();
  });

  test("Filter… keeps the handles when the filter hides the row under the pointer", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);

    await cell(page, 2, 1).hover();
    const menu = await openMenu(page, columnHandle(page), "Column City");
    await menu.getByRole("menuitem", { name: "Filter…" }).click();

    const dialog = page.getByRole("dialog", { name: "Column menu: City" });
    await dialog.getByRole("checkbox", { name: /^Lyon/ }).uncheck();
    await expect(hiddenRows(page)).toHaveCount(1);
    await expect(columnHandle(page)).toHaveAccessibleName("Column City");

    await page.keyboard.press("Escape");
    await expectMenuClosed(dialog);
    await expect(columnHandle(page)).toBeFocused();
  });

  test("leaves the header sort button to tables without handles; read-only stays as without them", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableSort: true, enableTableFilter: true });
    await setContent(page, PEOPLE);
    const buttons = page.locator(".ProseMirror .ate-table-column-button");
    await expect(buttons).toHaveCount(0);

    await setConfig(page, { enableTableHandles: false });
    await expect(buttons).toHaveCount(3);

    await setConfig(page, { editable: false });
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(buttons).toHaveCount(0);
    await setConfig(page, { enableTableHandles: true });
    await expect(buttons).toHaveCount(0);
    await expect(anyHandle(page)).toHaveCount(0);
  });

  test("previews a removal or an insertion as an overlay, without a transaction", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    const html = await editorHtml(page);

    await cell(page, 2, 0).hover();
    const menu = await openMenu(page, rowHandle(page), "Row 3");
    await expect(menu.getByRole("menuitem", { name: "Insert above" })).toBeFocused();
    await withEditor(
      page,
      editor => {
        const win = window as unknown as { ateTransactions: number };
        win.ateTransactions = 0;
        editor.on("transaction", () => {
          win.ateTransactions++;
        });
      },
      null
    );
    const row = await box(rows(page).nth(2));

    await menu.getByRole("menuitem", { name: "Delete row" }).hover();
    await expect(preview(page, "remove")).toBeVisible();
    const band = await box(preview(page, "remove"));
    expect(Math.abs(band.y - row.y)).toBeLessThan(2);
    expect(Math.abs(band.height - row.height)).toBeLessThan(2);

    await menu.getByRole("menuitem", { name: "Insert below" }).hover();
    await expect(preview(page, "remove")).toHaveCount(0);
    await expect(preview(page, "insert")).toBeVisible();
    const below = await box(preview(page, "insert"));
    expect(Math.abs(below.y + below.height / 2 - (row.y + row.height))).toBeLessThan(2);

    await menu.getByRole("menuitem", { name: "Insert above" }).hover();
    await expect
      .poll(async () => {
        const line = await box(preview(page, "insert"));
        return Math.abs(line.y + line.height / 2 - row.y);
      })
      .toBeLessThan(2);

    await page.keyboard.press("Escape");
    const tableMenu = await openMenu(page, tableHandle(page), "Table");
    await expect(tableMenu.getByRole("menuitemcheckbox", { name: "Header row" })).toBeFocused();
    await withEditor(
      page,
      () => {
        (window as unknown as { ateTransactions: number }).ateTransactions = 0;
      },
      null
    );
    await tableMenu.getByRole("menuitem", { name: "Delete table" }).hover();
    await expect(preview(page, "remove")).toBeVisible();
    const table = await box(page.locator(".ProseMirror table"));
    const whole = await box(preview(page, "remove"));
    expect(Math.abs(whole.y - table.y)).toBeLessThan(2);
    expect(Math.abs(whole.height - table.height)).toBeLessThan(2);

    expect(await editorHtml(page)).toBe(html);
    expect(
      await page.evaluate(() => (window as unknown as { ateTransactions: number }).ateTransactions)
    ).toBe(0);

    await tableMenu.getByRole("menuitem", { name: "Delete table" }).click();
    await expect(page.locator(".ProseMirror table")).toHaveCount(0);
  });

  test("previews the column to remove and the column line to insert", async ({ page }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);

    await cell(page, 1, 1).hover();
    const menu = await openMenu(page, columnHandle(page), "Column City");
    const city = await box(cell(page, 0, 1));

    await menu.getByRole("menuitem", { name: "Delete column" }).hover();
    await expect(preview(page, "remove")).toBeVisible();
    const band = await box(preview(page, "remove"));
    expect(Math.abs(band.x - city.x)).toBeLessThan(2);
    expect(Math.abs(band.width - city.width)).toBeLessThan(2);

    await menu.getByRole("menuitem", { name: "Insert right" }).hover();
    await expect(preview(page, "insert")).toBeVisible();
    const line = await box(preview(page, "insert"));
    expect(Math.abs(line.x + line.width / 2 - (city.x + city.width))).toBeLessThan(2);
  });

  test("+ between two handles inserts a row or a column there", async ({ page }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);

    await cell(page, 1, 0).hover();
    const ann = await box(rows(page).nth(1));
    await insertButton(page, "row").hover();
    await expect(preview(page, "insert")).toBeVisible();
    const line = await box(preview(page, "insert"));
    expect(Math.abs(line.y + line.height / 2 - (ann.y + ann.height))).toBeLessThan(2);
    await insertButton(page, "row").click();
    await expect(column(page, 0)).toHaveText(["Name", "Ann", "", "Bob", "Cid", "Dan"]);
    await page.keyboard.type("New");
    await expect(cell(page, 2, 0)).toHaveText("New");

    await cell(page, 1, 0).hover();
    await expect(insertButton(page, "column")).toHaveAccessibleName("Insert column");
    await insertButton(page, "column").click();
    await expect(headerCells(page)).toHaveText(["Name", "", "City", "Amount"]);
  });

  test("a cell range shows Merge cells and Split cell, enabled by what the range allows", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    const merge = page.getByRole("button", { name: "Merge cells" });
    const split = page.getByRole("button", { name: "Split cell" });

    await selectCells(page, [1, 0], [2, 1]);
    await expect(merge).toBeEnabled();
    await expect(split).toBeDisabled();

    await merge.click();
    await expect(page.locator('.ProseMirror td[colspan="2"][rowspan="2"]')).toHaveCount(1);
    await expect(split).toBeEnabled();
    await expect(merge).toBeDisabled();

    await split.click();
    await expect(page.locator('.ProseMirror td[colspan="2"]')).toHaveCount(0);

    await selectCells(page, [1, 0], [1, 2]);
    await expectMenuClosed(merge);
  });

  test("the table handle toggles the header row and column, showing their state, and deletes the table", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, "<p>Intro</p>" + PEOPLE);

    await cell(page, 1, 0).hover();
    const menu = await openMenu(page, tableHandle(page), "Table");
    const headerRow = menu.getByRole("menuitemcheckbox", { name: "Header row" });
    const headerColumn = menu.getByRole("menuitemcheckbox", { name: "Header column" });
    await expect(headerRow).toHaveAttribute("aria-checked", "true");
    await expect(headerColumn).toHaveAttribute("aria-checked", "false");
    await expect(menu.getByRole("menuitem", { name: "Delete table" })).toHaveClass(/is-danger/);
    await expect(menu.getByRole("separator")).toHaveCount(1);

    await headerRow.click();
    await expect(headerRow).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".ProseMirror table th")).toHaveCount(0);

    await headerColumn.click();
    await expect(headerColumn).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".ProseMirror table tr > th:first-child")).toHaveCount(5);

    await headerRow.click();
    await expect(headerRow).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".ProseMirror table th")).toHaveCount(7);

    await menu.getByRole("menuitem", { name: "Delete table" }).click();
    await expect(page.locator(".ProseMirror table")).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toContainText("Intro");
  });

  test("shows no handle, + or structure menu in a read-only editor", async ({ page }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    await setConfig(page, { editable: false });
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");

    await cell(page, 1, 0).hover();
    await cell(page, 1, 0).click();
    await expect(anyHandle(page)).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Merge cells" })).toHaveCount(0);

    await setConfig(page, { editable: true });
    await cell(page, 2, 0).hover();
    await expect(rowHandle(page)).toBeVisible();

    await withEditor(page, editor => editor.setEditable(false), null);
    await expect(anyHandle(page)).toHaveCount(0);
    await cell(page, 1, 1).hover();
    await expect(anyHandle(page)).toHaveCount(0);
  });

  test("with a filter on, disables what would change hidden rows and says why", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableSort: true, enableTableFilter: true });
    await setContent(page, PEOPLE);
    expect(await filterColumn(page, 1, { kind: "values", values: ["Paris"] })).toBe(true);
    await expect(hiddenRows(page)).toHaveCount(2);

    await cell(page, 1, 1).hover();
    let menu = await openMenu(page, columnHandle(page), "Column City");
    const deleteColumn = menu.getByRole("menuitem", { name: "Delete column" });
    const columnReason = "With a filter on, the column cannot be deleted: clear the filters.";
    await expect(deleteColumn).toHaveAttribute("aria-disabled", "true");
    await expect(deleteColumn).toHaveAccessibleDescription(columnReason);
    await expect(menu.getByText(columnReason)).toBeVisible();
    await deleteColumn.click({ force: true });
    await expect(headerCells(page)).toHaveCount(3);
    await page.keyboard.press("Escape");

    menu = await openMenu(page, tableHandle(page), "Table");
    for (const name of ["Header row", "Header column"]) {
      const toggle = menu.getByRole("menuitemcheckbox", { name });
      await expect(toggle).toHaveAttribute("aria-disabled", "true");
      await expect(toggle).toHaveAccessibleDescription(HEADER_REASON);
    }
    const deleteTable = menu.getByRole("menuitem", { name: "Delete table" });
    await expect(deleteTable).toHaveAttribute("aria-disabled", "true");
    await expect(deleteTable).toHaveAccessibleDescription(
      "With a filter on, the table cannot be deleted: clear the filters."
    );
    await deleteTable.click({ force: true });
    await expect(page.locator(".ProseMirror table")).toHaveCount(1);
    await page.keyboard.press("Escape");

    await cell(page, 0, 0).hover();
    menu = await openMenu(page, rowHandle(page), "Row 1");
    await expect(menu.getByRole("menuitem", { name: "Insert above" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await expect(menu.getByRole("menuitem", { name: "Delete row" })).toHaveAccessibleDescription(
      HEADER_REASON
    );
    await expect(menu.getByRole("menuitem", { name: "Insert below" })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await page.keyboard.press("Escape");

    await cell(page, 1, 0).hover();
    menu = await openMenu(page, rowHandle(page), "Row 2");
    await expect(menu.getByRole("menuitem", { name: "Delete row" })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await menu.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(visibleColumn(page, 0)).toHaveText(["Cid"]);
    await expect(hiddenRows(page)).toHaveCount(2);

    await cell(page, 2, 0).hover();
    menu = await openMenu(page, rowHandle(page), "Row 3");
    await menu.getByRole("menuitem", { name: "Insert below" }).click();
    await expect(visibleColumn(page, 0)).toHaveText(["Cid", ""]);
    await expect(hiddenRows(page)).toHaveCount(2);
    const html = await editorHtml(page);
    for (const name of ["Bob", "Dan"]) {
      expect(html).toContain(name);
    }
    expect(html).not.toContain("Ann");
  });

  test("translates the handles and their menus", async ({ page }) => {
    await setConfig(page, { ...HANDLES, locale: "pt-BR", enableTableFilter: true });
    await setContent(
      page,
      tableHtml(
        ["Nome", "Cidade"],
        [
          ["Ana", "Recife"],
          ["Bia", "Natal"],
        ]
      )
    );

    await cell(page, 1, 1).hover();
    await expect(rowHandle(page)).toHaveAccessibleName("Linha 2");
    await expect(columnHandle(page)).toHaveAccessibleName("Coluna Cidade");
    await expect(tableHandle(page)).toHaveAccessibleName("Tabela");
    await expect(insertButton(page, "row")).toHaveAccessibleName("Inserir linha");
    await expect(insertButton(page, "column")).toHaveAccessibleName("Inserir coluna");

    let menu = await openMenu(page, rowHandle(page), "Linha 2");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Inserir acima",
      "Inserir abaixo",
      "Mesclar células",
      "Excluir linha",
    ]);
    await page.keyboard.press("Escape");

    menu = await openMenu(page, columnHandle(page), "Coluna Cidade");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Filtrar…",
      "Inserir à esquerda",
      "Inserir à direita",
      "Mesclar células",
      "Excluir coluna",
    ]);
    await page.keyboard.press("Escape");

    menu = await openMenu(page, tableHandle(page), "Tabela");
    await expect(menu.getByRole("menuitemcheckbox")).toHaveText([
      "Linha de cabeçalho",
      "Coluna de cabeçalho",
    ]);
    await expect(menu.getByRole("menuitem")).toHaveText(["Excluir tabela"]);
    await page.keyboard.press("Escape");

    await filterColumn(page, 1, { kind: "values", values: ["Recife"] });
    menu = await openMenu(page, columnHandle(page), "Coluna Cidade");
    await expect(
      menu.getByText("Com filtro ativo a coluna não pode ser excluída: limpe os filtros.")
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const names: [string, string][] = [
      ["fr", "Ligne 2"],
      ["de", "Zeile 2"],
      ["es", "Fila 2"],
      ["it", "Riga 2"],
      ["en", "Row 2"],
    ];
    for (const [locale, name] of names) {
      await setConfig(page, { locale });
      await expect(rowHandle(page)).toHaveAccessibleName(name);
    }
  });

  test("works from the keyboard: Shift+F10, Enter, the arrows, Tab and Escape", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    await cell(page, 1, 0).click();
    await page.mouse.move(2, 2);
    await expect(anyHandle(page)).toHaveCount(0);

    await page.keyboard.press("Shift+F10");
    const row = rowHandle(page);
    await expect(row).toBeFocused();
    await expect(row).toHaveAccessibleName("Row 2");
    await expect(row).toHaveAttribute("aria-haspopup", "menu");
    await expect(row).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Row 2" });
    await expect(menu).toBeVisible();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitem", { name: "Insert above" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Insert below" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Delete row" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Insert above" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expectMenuClosed(menu);
    await expect(row).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(tableHandle(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(columnHandle(page)).toBeFocused();
    await expect(columnHandle(page)).toHaveAccessibleName("Column Name");

    await page.keyboard.press("Enter");
    const columnMenu = page.getByRole("menu", { name: "Column Name" });
    await expect(columnMenu.getByRole("menuitem", { name: "Insert left" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(headerCells(page)).toHaveText(["Name", "", "City", "Amount"]);
    await expect(page.locator(".ProseMirror")).toBeFocused();

    await page.keyboard.press("Shift+F10");
    await expect(rowHandle(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ProseMirror")).toBeFocused();
  });

  test("without them, Backspace on a whole selected row only empties its cells, as before", async ({
    page,
  }) => {
    await setContent(page, PEOPLE);

    await selectCells(page, [2, 0], [2, 2]);
    await expect(page.getByRole("button", { name: "Merge cells" })).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(rows(page)).toHaveCount(5);
    await expect(column(page, 0)).toHaveText(["Name", "Ann", "", "Cid", "Dan"]);
    await expect(rows(page).nth(2)).toHaveText("");

    await cell(page, 1, 0).click();
    await expect(page.getByRole("button", { name: "Add row before" })).toBeVisible();
    await expect(anyHandle(page)).toHaveCount(0);
  });

  test("turns on and off from the enableTableHandles input, which wins over the config", async ({
    page,
  }) => {
    await setContent(page, PEOPLE);

    await setInput(page, "enableTableHandles", true);
    await cell(page, 1, 0).hover();
    await expect(rowHandle(page)).toHaveAccessibleName("Row 2");
    await cell(page, 1, 0).click();
    await expect(page.getByRole("button", { name: "Add row before" })).toHaveCount(0);

    await setConfig(page, HANDLES);
    await setInput(page, "enableTableHandles", false);
    await expect(anyHandle(page)).toHaveCount(0);
    await cell(page, 2, 0).click();
    await expect(page.getByRole("button", { name: "Add row before" })).toBeVisible();

    await setInput(page, "enableTableHandles", undefined);
    await expect(page.locator("ate-table-bubble-menu")).toHaveCount(0);
    await cell(page, 2, 1).hover();
    await expect(rowHandle(page)).toHaveAccessibleName("Row 3");
  });

  test("a column picked from its handle while a filter hides the last rows shows no merge bar", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris", "Lyon"] });
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "Bob", "Cid"]);
    const bar = page.getByRole("button", { name: "Merge cells" });

    await cell(page, 1, 1).hover();
    let menu = await openMenu(page, columnHandle(page), "Column City");
    await expect(page.locator(".ProseMirror tr > .selectedCell:nth-child(2)")).toHaveCount(4);
    const mergeItem = menu.getByRole("menuitem", { name: "Merge cells" });
    await expect(mergeItem).toHaveAttribute("aria-disabled", "true");
    await expect(mergeItem).toHaveAccessibleDescription(CELLS_REASON);
    await columnHandle(page).click();
    await expectMenuClosed(menu);
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.waitForTimeout(300);
    await expectMenuClosed(bar);

    menu = await openMenu(page, columnHandle(page), "Column City");
    await page.keyboard.press("Escape");
    await expect(columnHandle(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.waitForTimeout(300);
    await expectMenuClosed(bar);
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "Bob", "Cid"]);
  });

  test("the row and column menus merge a whole row or column and split a cell as wide or tall as the table", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, PEOPLE);
    const wide = page.locator('.ProseMirror td[colspan="3"]');

    await cell(page, 2, 0).hover();
    let menu = await openMenu(page, rowHandle(page), "Row 3");
    await expect(menu.getByRole("menuitem", { name: "Split cell" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Merge cells" }).click();
    await expectMenuClosed(menu);
    await expect(wide).toHaveCount(1);
    await expect(rows(page).nth(2).locator("td")).toHaveCount(1);

    await wide.hover();
    menu = await openMenu(page, rowHandle(page), "Row 3");
    await expect(menu.getByRole("menuitem", { name: "Merge cells" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Split cell" }).click();
    await expect(wide).toHaveCount(0);
    await expect(rows(page).nth(2).locator("td")).toHaveCount(3);

    await cell(page, 1, 2).hover();
    menu = await openMenu(page, columnHandle(page), "Column Amount");
    await menu.getByRole("menuitem", { name: "Merge cells" }).click();
    const tall = page.locator('.ProseMirror th[rowspan="5"]');
    await expect(tall).toHaveCount(1);
    await expect(column(page, 2)).toHaveCount(1);

    await tall.hover();
    await columnHandle(page).click();
    menu = page.getByRole("menu", { name: /^Column Amount/ });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Merge cells" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Split cell" }).click();
    await expect(tall).toHaveCount(0);
    await expect(column(page, 2)).toHaveCount(5);
  });

  test("with a filter on, inserting a column is disabled in the menu and on +, with the reason", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableSort: true, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });
    await expect(hiddenRows(page)).toHaveCount(2);

    await cell(page, 1, 1).hover();
    const plus = insertButton(page, "column");
    await expect(plus).toHaveAttribute("aria-disabled", "true");
    await expect(plus).toHaveAccessibleName("Insert column");
    await expect(plus).toHaveAccessibleDescription(INSERT_COLUMN_REASON);
    await plus.hover();
    await expect(preview(page, "insert")).toHaveCount(0);
    await plus.click({ force: true });
    await expect(headerCells(page)).toHaveCount(3);
    await expect(hiddenRows(page)).toHaveCount(2);
    await expect(insertButton(page, "row")).not.toHaveAttribute("aria-disabled", "true");

    await cell(page, 1, 1).hover();
    const menu = await openMenu(page, columnHandle(page), "Column City");
    for (const name of ["Insert left", "Insert right"]) {
      const item = menu.getByRole("menuitem", { name });
      await expect(item).toHaveAttribute("aria-disabled", "true");
      await expect(item).toHaveAccessibleDescription(INSERT_COLUMN_REASON);
    }
    await menu.getByRole("menuitem", { name: "Insert left" }).click({ force: true });
    await expect(headerCells(page)).toHaveCount(3);
    await expect(hiddenRows(page)).toHaveCount(2);
  });

  test("the column menu opens over a row only the cursor keeps shown, and the row stays", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });
    await expect(visibleColumn(page, 1)).toHaveText(["Paris", "Paris"]);

    await cell(page, 1, 1).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await expect(visibleColumn(page, 1)).toHaveText(["Parisx", "Paris"]);

    await cell(page, 1, 1).hover();
    const menu = await openMenu(page, columnHandle(page), "Column City");
    await expect(menu.getByRole("menuitem", { name: "Delete column" })).toBeVisible();
    await expect(columnHandle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(visibleColumn(page, 1)).toHaveText(["Parisx", "Paris"]);
  });

  test("a row inserted from a handle stays shown until the filters change", async ({ page }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "Cid"]);

    await cell(page, 1, 0).hover();
    const menu = await openMenu(page, rowHandle(page), "Row 2");
    await menu.getByRole("menuitem", { name: "Insert below" }).click();
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "", "Cid"]);

    await cell(page, 4, 0).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "", "Cidx"]);

    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "Cidx"]);
  });

  test("opening a handle again over a row kept shown pins it once", async ({ page }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });

    await cell(page, 1, 0).hover();
    let menu = await openMenu(page, rowHandle(page), "Row 2");
    await menu.getByRole("menuitem", { name: "Insert below" }).click();
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "", "Cid"]);
    await expect.poll(() => pinnedRows(page)).toBe(1);

    for (let round = 0; round < 2; round++) {
      await cell(page, 2, 0).hover();
      menu = await openMenu(page, rowHandle(page), "Row 3");
      await page.keyboard.press("Escape");
      await expectMenuClosed(menu);
    }
    await expect.poll(() => pinnedRows(page)).toBe(1);
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "", "Cid"]);
  });

  test("Backspace on a row picked from its handle leaves the cursor in a row the filter shows", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });
    await expect(hiddenRows(page)).toHaveCount(2);

    await cell(page, 1, 0).hover();
    const menu = await openMenu(page, rowHandle(page), "Row 2");
    await page.keyboard.press("Escape");
    await expectMenuClosed(menu);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.keyboard.press("Backspace");

    await expect(visibleColumn(page, 0)).toHaveText(["Cid"]);
    await expect(hiddenRows(page)).toHaveCount(2);
  });

  test("follows tableBubbleMenu and cellBubbleMenu: an action set to false leaves the handle menus", async ({
    page,
  }) => {
    await setConfig(page, {
      ...HANDLES,
      tableBubbleMenu: { deleteTable: false, addColumnAfter: false, deleteRow: false },
      cellBubbleMenu: { mergeCells: false },
    });
    await setContent(page, PEOPLE);

    await cell(page, 1, 1).hover();
    await expect(insertButton(page, "row")).toBeVisible();
    await expect(insertButton(page, "column")).toHaveCount(0);

    let menu = await openMenu(page, tableHandle(page), "Table");
    await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(2);
    await expect(menu.getByRole("menuitem")).toHaveCount(0);
    await expect(menu.getByRole("separator")).toHaveCount(0);
    await page.keyboard.press("Escape");

    menu = await openMenu(page, columnHandle(page), "Column City");
    await expect(menu.getByRole("menuitem")).toHaveText(["Insert left", "Delete column"]);
    await page.keyboard.press("Escape");

    menu = await openMenu(page, rowHandle(page), "Row 2");
    await expect(menu.getByRole("menuitem")).toHaveText(["Insert above", "Insert below"]);
    await page.keyboard.press("Delete");
    await expect(rows(page)).toHaveCount(5);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(rows(page)).toHaveCount(5);
    await expect(column(page, 0)).toHaveText(["Name", "", "Bob", "Cid", "Dan"]);
  });

  test("with merged cells, a row handle previews, deletes and Backspace removes every row it selects", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, MERGED);

    await cellWithText(page, "b2").hover();
    let menu = await openMenu(page, rowHandle(page), "Row 3");
    await expect(page.locator(".ProseMirror .selectedCell")).toHaveCount(5);
    const first = await box(rows(page).nth(1));
    const second = await box(rows(page).nth(2));
    await menu.getByRole("menuitem", { name: "Delete row" }).hover();
    await expect(preview(page, "remove")).toBeVisible();
    const band = await box(preview(page, "remove"));
    expect(Math.abs(band.y - first.y)).toBeLessThan(2);
    expect(Math.abs(band.y + band.height - (second.y + second.height))).toBeLessThan(2);

    await menu.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(column(page, 0)).toHaveText(["H1", "D"]);

    await page.keyboard.press("ControlOrMeta+z");
    await expect(rows(page)).toHaveCount(4);
    await expect(column(page, 0)).toHaveText(["H1", "A", "b2", "D"]);
    await cellWithText(page, "b2").hover();
    menu = await openMenu(page, rowHandle(page), "Row 3");
    await page.keyboard.press("Escape");
    await expectMenuClosed(menu);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(rows(page)).toHaveCount(2);
    await expect(column(page, 0)).toHaveText(["H1", "D"]);
  });

  test("over a merged cell, the handles follow the row and the column under the pointer", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, MERGED);

    const tall = cellWithText(page, "A");
    const a = await box(tall);
    await tall.hover({ position: { x: a.width / 2, y: 5 } });
    await expect(rowHandle(page)).toHaveAccessibleName("Row 2");
    await tall.hover({ position: { x: a.width / 2, y: a.height - 5 } });
    await expect(rowHandle(page)).toHaveAccessibleName("Row 3");
    const third = await box(rows(page).nth(2));
    await expect
      .poll(async () => {
        const grip = await box(rowHandle(page));
        return Math.abs(grip.y + grip.height / 2 - (third.y + third.height / 2));
      })
      .toBeLessThan(2);

    const wide = cellWithText(page, "D");
    const d = await box(wide);
    await wide.hover({ position: { x: 5, y: d.height / 2 } });
    await expect(columnHandle(page)).toHaveAccessibleName("Column H1");
    await wide.hover({ position: { x: d.width - 5, y: d.height / 2 } });
    await expect(columnHandle(page)).toHaveAccessibleName("Column H2");
    const h2 = await box(cellWithText(page, "H2"));
    await expect
      .poll(async () => {
        const grip = await box(columnHandle(page));
        return Math.abs(grip.x + grip.width / 2 - (h2.x + h2.width / 2));
      })
      .toBeLessThan(2);
  });

  test("the range bar says why Merge cells is disabled while a filter hides rows", async ({
    page,
  }) => {
    await setConfig(page, { ...HANDLES, enableTableFilter: true });
    await setContent(page, PEOPLE);
    await filterColumn(page, 1, { kind: "values", values: ["Paris"] });
    await expect(visibleColumn(page, 0)).toHaveText(["Ann", "Cid"]);
    const merge = page.getByRole("button", { name: "Merge cells" });

    await selectCells(page, [1, 0], [3, 0]);
    await expect(merge).toBeDisabled();
    await expect(merge).toHaveAccessibleDescription(CELLS_REASON);
    await expect(page.getByText(CELLS_REASON)).toBeVisible();

    await selectCells(page, [1, 0], [1, 1]);
    await expect(merge).toBeEnabled();
    await expect(page.getByText(CELLS_REASON)).toHaveCount(0);
  });
});

test.describe("Table handles on a touch screen", () => {
  test.use({ locale: "en-US", hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".ate-editor")).toBeVisible();
    await clearEditor(page);
  });

  test("a tap shows the handles of its cell; they stay until a tap outside the table", async ({
    page,
  }) => {
    await setConfig(page, HANDLES);
    await setContent(page, "<p>Intro</p>" + PEOPLE);

    const target = await box(cell(page, 2, 1));
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    await expect(rowHandle(page)).toHaveAccessibleName("Row 3");
    await page.waitForTimeout(600);
    await expect(rowHandle(page)).toBeVisible();
    await expect(columnHandle(page)).toHaveAccessibleName("Column City");

    await rowHandle(page).tap();
    const menu = page.getByRole("menu", { name: "Row 3" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(600);
    await expect(menu).toBeVisible();
    await expect(rowHandle(page)).toHaveAttribute("aria-expanded", "true");

    const intro = await box(page.locator(".ProseMirror > p").first());
    await page.touchscreen.tap(intro.x + 10, intro.y + intro.height / 2);
    await expectMenuClosed(menu);
    await expect(anyHandle(page)).toHaveCount(0);
  });
});
