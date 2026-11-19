using Pv.Blazor;

namespace Pv.Contract;

/// <summary>
/// Drives the sample app, either in a real browser or rendered in bUnit with a fake viewer, so that one scenario can
/// run against both and show that the fake behaves like the real viewer.
/// </summary>
public interface ISampleDriver
{
    /// <summary>Opens the three-page letter.pdf, with extra query options such as <c>confirmDraw=true</c>.</summary>
    Task OpenAsync(string options = "");

    /// <summary>Clicks one of the sample's own controls by its test ID.</summary>
    Task ClickAsync(string testId);

    Task WaitForToolAsync(ViewerTool tool, string? kind = null);

    /// <summary>Draws a rectangle, and returns the ID of the object or draft it made.</summary>
    Task<string> DrawAsync(PageRect rect);

    Task DragObjectByAsync(string id, double deltaX, double deltaY);

    Task ClickObjectAsync(string id);

    Task ClickEmptyPageAsync();

    /// <summary>Focuses an object and presses Delete.</summary>
    Task PressDeleteAsync(string id);

    /// <summary>Waits until one of the sample's controls shows this text.</summary>
    Task ExpectTextAsync(string testId, string text);

    Task ExpectCountsAsync(int objects, int drafts);
}

/// <summary>Scenarios that must play out the same in a browser and with the fake viewer.</summary>
public static class SampleContract
{
    private static readonly PageRect Drawn = new(120, 160, 180, 160);

    private static readonly Dictionary<string, Func<ISampleDriver, Task>> Scenarios = new()
    {
        ["DrawWithKindedTool"] = async driver =>
        {
            await driver.OpenAsync();
            await ChooseDrawToolAsync(driver);
            var id = await driver.DrawAsync(Drawn);
            await driver.ExpectTextAsync("last-change", $"Added User {id}");
            await driver.ExpectTextAsync("last-kind", "heading");
            await driver.ExpectCountsAsync(objects: 1, drafts: 0);
        },
        ["KeepConfirmedDraft"] = async driver =>
        {
            await driver.OpenAsync("confirmDraw=true");
            await ChooseDrawToolAsync(driver);
            var id = await driver.DrawAsync(Drawn);
            await driver.ExpectCountsAsync(objects: 0, drafts: 1);
            await driver.ClickAsync("dialog-save");
            await driver.ExpectCountsAsync(objects: 1, drafts: 0);
            await driver.ExpectTextAsync("last-change", $"Added User {id}");
        },
        ["DiscardCanceledDraft"] = async driver =>
        {
            await driver.OpenAsync("confirmDraw=true");
            await ChooseDrawToolAsync(driver);
            await driver.DrawAsync(Drawn);
            await driver.ClickAsync("dialog-cancel");
            await driver.ExpectCountsAsync(objects: 0, drafts: 0);
            await driver.ExpectTextAsync("last-change", "");
        },
        ["DrawToolMovesObjectItIsPressedOn"] = async driver =>
        {
            await driver.OpenAsync();
            await driver.ClickAsync("add-object");
            await driver.ExpectTextAsync("last-change", "Added Api code-1");
            await ChooseDrawToolAsync(driver);
            await driver.DragObjectByAsync("code-1", 40, 20);
            await driver.ExpectTextAsync("last-change", "Updated User code-1");
            await driver.ExpectTextAsync("selected-object", "code-1");
            await driver.ExpectCountsAsync(objects: 1, drafts: 0);
        },
        ["DragSelectsAndMoves"] = async driver =>
        {
            await driver.OpenAsync();
            await driver.ClickAsync("add-object");
            await driver.ExpectTextAsync("last-change", "Added Api code-1");
            await driver.DragObjectByAsync("code-1", 40, 20);
            await driver.ExpectTextAsync("last-change", "Updated User code-1");
            await driver.ExpectTextAsync("selected-object", "code-1");
        },
        ["ClickSelectsThenClears"] = async driver =>
        {
            await driver.OpenAsync();
            await driver.ClickAsync("add-object");
            await driver.ClickObjectAsync("code-1");
            await driver.ExpectTextAsync("selected-ids", "code-1");
            await driver.ClickEmptyPageAsync();
            await driver.ExpectTextAsync("selected-object", "none");
            await driver.ExpectTextAsync("selected-ids", "");
        },
        ["DeleteKeyAsksApplication"] = async driver =>
        {
            await driver.OpenAsync("confirmDelete=true");
            await driver.ClickAsync("add-object");
            await driver.PressDeleteAsync("code-1");
            await driver.ExpectTextAsync("confirm-delete", "Delete code-1");
            await driver.ExpectCountsAsync(objects: 1, drafts: 0);
            await driver.ClickAsync("confirm-delete");
            await driver.ExpectCountsAsync(objects: 0, drafts: 0);
        },
        ["NudgeFromCodeIsUserChange"] = async driver =>
        {
            await driver.OpenAsync();
            await driver.ClickAsync("add-object");
            await driver.ClickObjectAsync("code-1");
            await driver.ExpectTextAsync("selected-object", "code-1");
            await driver.ClickAsync("nudge-right");
            await driver.ExpectTextAsync("last-change", "Updated User code-1");
        },
        ["BoundSelectionSelectsAddedObject"] = async driver =>
        {
            await driver.OpenAsync();
            await driver.ClickAsync("add-selected-object");
            await driver.ExpectTextAsync("selected-ids", "code-1");
        },
    };

    public static TheoryData<string> Names => [.. Scenarios.Keys];

    public static Task RunAsync(string name, ISampleDriver driver) => Scenarios[name](driver);

    /// <summary>The sample's draw tool gives its objects the kind "heading".</summary>
    private static async Task ChooseDrawToolAsync(ISampleDriver driver)
    {
        await driver.ClickAsync("tool-draw");
        await driver.WaitForToolAsync(ViewerTool.DrawRectangle, "heading");
    }
}
