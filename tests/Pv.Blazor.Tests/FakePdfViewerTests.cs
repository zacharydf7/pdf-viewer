using Bunit;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;
using Microsoft.JSInterop;
using Pv.Testing.Bunit;

namespace Pv.Blazor.Tests;

public class FakePdfViewerTests : BunitContext
{
    private static readonly ViewerObject Region = new("region", 1, new PageRect(50, 50, 150, 80));
    private readonly FakePdfViewers _viewers;

    public FakePdfViewerTests()
    {
        _viewers = Services.AddFakePdfViewers();
    }

    /// <summary>
    /// An application page that owns its objects, writes the user's changes into them, and records every event its
    /// viewer raises.
    /// </summary>
    private sealed class ApplicationPage : ComponentBase
    {
        public List<ViewerObject> Objects { get; } = [];

        public List<object> Events { get; } = [];

        public PdfViewerController Controller { get; } = new();

        /// <summary>Completes the drawn-object handler, keeping the object when given true.</summary>
        public TaskCompletionSource<bool> Keep { get; } = new();

        [Parameter] public PdfViewerOptions? Options { get; set; }

        [Parameter] public bool ReadOnly { get; set; }

        [Parameter] public bool ConfirmDraw { get; set; }

        [Parameter] public bool ConfirmDelete { get; set; }

        public void Refresh() => StateHasChanged();

        protected override void BuildRenderTree(RenderTreeBuilder builder)
        {
            builder.OpenComponent<PdfViewer>(0);
            builder.AddComponentParameter(1, nameof(PdfViewer.Source), (PdfSource?)"/a.pdf");
            builder.AddComponentParameter(2, nameof(PdfViewer.Objects), Objects);
            builder.AddComponentParameter(3, nameof(PdfViewer.Controller), Controller);
            builder.AddComponentParameter(4, nameof(PdfViewer.Options), Options);
            builder.AddComponentParameter(5, nameof(PdfViewer.ReadOnly), ReadOnly);
            builder.AddComponentParameter(6, nameof(PdfViewer.OnObjectsChanged),
                EventCallback.Factory.Create<ObjectsChangedArgs>(this, ApplyUserChanges));
            builder.AddComponentParameter(7, nameof(PdfViewer.OnSelectionChanged),
                EventCallback.Factory.Create<SelectionChangedArgs>(this, Events.Add));
            builder.AddComponentParameter(8, nameof(PdfViewer.OnDocumentLoaded),
                EventCallback.Factory.Create<DocumentLoadedArgs>(this, Events.Add));
            builder.AddComponentParameter(9, nameof(PdfViewer.OnPageChanged),
                EventCallback.Factory.Create<int>(this, page => Events.Add(page)));
            if (ConfirmDraw)
            {
                builder.AddComponentParameter(10, nameof(PdfViewer.OnObjectDrawn),
                    EventCallback.Factory.Create<ObjectDrawnArgs>(this, KeepIfConfirmedAsync));
            }
            if (ConfirmDelete)
            {
                builder.AddComponentParameter(11, nameof(PdfViewer.OnDeleteRequested),
                    EventCallback.Factory.Create<DeleteRequestedArgs>(this, Events.Add));
            }
            builder.CloseComponent();
        }

        private void ApplyUserChanges(ObjectsChangedArgs args)
        {
            Events.Add(args);
            Objects.AddRange(args.Added);
            foreach (var update in args.Updated)
            {
                Objects[Objects.FindIndex(viewerObject => viewerObject.Id == update.Object.Id)] = update.Object;
            }
            Objects.RemoveAll(viewerObject => args.Removed.Any(removed => removed.Id == viewerObject.Id));
        }

        private async Task KeepIfConfirmedAsync(ObjectDrawnArgs args)
        {
            if (await Keep.Task)
            {
                Objects.Add(args.Object);
            }
        }
    }

    private FakePdfViewer Viewer => _viewers.Viewer;

    /// <summary>Renders the page with its objects, then lets the fake finish opening a three-page document.</summary>
    private async Task<IRenderedComponent<ApplicationPage>> OpenAsync(
        Action<ComponentParameterCollectionBuilder<ApplicationPage>>? parameters = null,
        params ViewerObject[] objects)
    {
        var page = await RenderWithObjectsAsync(parameters, objects);
        await Viewer.LoadDocumentAsync(pageCount: 3);
        return page;
    }

    /// <summary>Renders the page with its objects while its document is still opening.</summary>
    private Task<IRenderedComponent<ApplicationPage>> RenderWithObjectsAsync(params ViewerObject[] objects) =>
        RenderWithObjectsAsync(null, objects);

    private async Task<IRenderedComponent<ApplicationPage>> RenderWithObjectsAsync(
        Action<ComponentParameterCollectionBuilder<ApplicationPage>>? parameters, ViewerObject[] objects)
    {
        var page = Render<ApplicationPage>(builder => parameters?.Invoke(builder));
        page.Instance.Objects.AddRange(objects);
        await page.InvokeAsync(page.Instance.Refresh);
        return page;
    }

    private static Task DrawHeadingsAsync(IRenderedComponent<ApplicationPage> page) =>
        page.Instance.Controller.SetToolAsync(ViewerTool.DrawRectangle, new ViewerDrawDefaults { Kind = "heading" });

    [Fact]
    public async Task LoadDocumentAsync_ShouldRaiseDocumentLoaded_WhenSourceIsOpening()
    {
        var page = Render<ApplicationPage>();
        Assert.True(Viewer.IsOpening);

        await Viewer.LoadDocumentAsync(pageCount: 3);

        Assert.Equal(new DocumentLoadedArgs(3), Assert.Single(page.Instance.Events));
        Assert.Equal((3, 1), (page.Instance.Controller.PageCount, page.Instance.Controller.CurrentPage));
    }

    [Fact]
    public async Task LoadDocumentAsync_ShouldThrow_WhenNoSourceIsOpening()
    {
        await OpenAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(() => Viewer.LoadDocumentAsync());
    }

    [Fact]
    public async Task FailDocumentAsync_ShouldReportClosedDocument_WhenSourceIsOpening()
    {
        var errors = new List<ViewerError>();
        Render<PdfViewer>(parameters => parameters
            .Add(viewer => viewer.Source, "/a.pdf")
            .Add(viewer => viewer.OnError, errors.Add));

        await Viewer.FailDocumentAsync(ViewerErrorCode.Network);

        Assert.Equal(ViewerErrorCode.Network, Assert.Single(errors).Code);
        Assert.True(errors[0].DocumentClosed);
    }

    [Fact]
    public async Task ReportErrorAsync_ShouldReportErrorAndKeepDocumentOpen_WhenDocumentIsOpen()
    {
        var errors = new List<ViewerError>();
        Render<PdfViewer>(parameters => parameters
            .Add(viewer => viewer.Source, "/a.pdf")
            .Add(viewer => viewer.OnError, errors.Add));
        await Viewer.LoadDocumentAsync();

        await Viewer.ReportErrorAsync();

        Assert.Equal((ViewerErrorCode.Render, false), (Assert.Single(errors).Code, errors[0].DocumentClosed));
        Assert.True(Viewer.IsDocumentOpen);
    }

    [Fact]
    public async Task GoToPageAsync_ShouldOpenOnRequestedPage_WhenIssuedWhileDocumentIsOpening()
    {
        var page = Render<ApplicationPage>();
        var turning = page.Instance.Controller.GoToPageAsync(2);

        await Viewer.LoadDocumentAsync(pageCount: 3);
        await turning;

        Assert.Equal([new DocumentLoadedArgs(3), 2], page.Instance.Events);
        Assert.Equal(2, Viewer.CurrentPage);
    }

    [Fact]
    public async Task SimulateDrawAsync_ShouldReportObjectWithToolKind_WhenNothingDecidesOnDrawnObjects()
    {
        var page = await OpenAsync();
        await DrawHeadingsAsync(page);

        var id = await Viewer.SimulateDrawAsync(new PageRect(10, 20, 100, 40));

        var changed = Assert.IsType<ObjectsChangedArgs>(Assert.Single(page.Instance.Events.Skip(1)));
        var added = Assert.Single(changed.Added);
        Assert.Equal((id, "heading", 1), (added.Id, added.Kind, added.Page));
        Assert.Equal(new PageRect(10, 20, 100, 40), added.Rect);
        Assert.Equal(added, Assert.Single(Viewer.Objects));
    }

    [Fact]
    public async Task SimulateDrawAsync_ShouldReportAddAndSelectionTogether_WhenSelectOnCreateIsOn()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.Options, new() { SelectOnCreate = true }));
        await DrawHeadingsAsync(page);

        var id = await Viewer.SimulateDrawAsync(new PageRect(10, 20, 100, 40));

        // One notification carries both, with the sequence of the later change.
        var events = page.Instance.Events.Skip(1).ToList();
        Assert.Equal(2, events.Count);
        Assert.Equal(2, Assert.IsType<ObjectsChangedArgs>(events[0]).Sequence);
        Assert.Equal(new SelectionChangedArgs(2, ChangeOrigin.User, id, 1), events[1]);
    }

    [Fact]
    public async Task SimulateDrawAsync_ShouldRoundRectangle_WhenRoundCoordinatesIsOn()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.Options, new() { RoundCoordinates = true }));
        await DrawHeadingsAsync(page);

        await Viewer.SimulateDrawAsync(new PageRect(10.4, 20.6, 100.2, 40.3));

        Assert.Equal(new PageRect(10, 21, 101, 40), Assert.Single(Viewer.Objects).Rect);
    }

    [Fact]
    public async Task SimulateDrawAsync_ShouldHoldDraftUntilHandlerKeepsIt_WhenHandlerDecides()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.ConfirmDraw, true));
        await DrawHeadingsAsync(page);

        var drawing = Viewer.SimulateDrawAsync(new PageRect(10, 20, 100, 40));
        page.WaitForAssertion(() => Assert.Single(Viewer.Drafts));
        var whileWaiting = Viewer.Objects.Count;
        page.Instance.Keep.SetResult(true);
        var id = await drawing;

        Assert.Equal(0, whileWaiting);
        Assert.Equal(id, Assert.Single(Viewer.Objects).Id);
        Assert.Empty(Viewer.Drafts);
    }

    [Fact]
    public async Task SimulateDrawAsync_ShouldDiscardDraft_WhenHandlerFinishesWithoutKeepingIt()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.ConfirmDraw, true));
        await DrawHeadingsAsync(page);
        page.Instance.Keep.SetResult(false);

        await Viewer.SimulateDrawAsync(new PageRect(10, 20, 100, 40));

        Assert.Empty(Viewer.Drafts);
        Assert.Empty(Viewer.Objects);
    }

    [Fact]
    public async Task SimulateDrawAsync_ShouldThrow_WhenViewerIsReadOnly()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.ReadOnly, true));
        await DrawHeadingsAsync(page);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Viewer.SimulateDrawAsync(new PageRect(10, 20, 100, 40)));
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldSelectThenReportMove_WhenObjectIsDragged()
    {
        var page = await OpenAsync(objects: Region);
        var moved = new PageRect(90, 70, 150, 80);

        await Viewer.SimulateEditAsync("region", moved, EditGesture.Move);

        var events = page.Instance.Events.Skip(1).ToList();
        Assert.Equal(new SelectionChangedArgs(2, ChangeOrigin.User, "region", 1), events[0]);
        var update = Assert.Single(Assert.IsType<ObjectsChangedArgs>(events[1]).Updated);
        Assert.Equal((moved, EditGesture.Move), (update.Object.Rect, update.Gesture));
        Assert.Equal(moved, Assert.Single(page.Instance.Objects).Rect);
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldThrow_WhenResizingObjectThatIsNotSelected()
    {
        await OpenAsync(objects: Region);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Viewer.SimulateEditAsync("region", new PageRect(50, 50, 200, 80), EditGesture.Resize));
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldThrow_WhenMoveChangesSize()
    {
        await OpenAsync(objects: Region);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            Viewer.SimulateEditAsync("region", new PageRect(90, 70, 100, 80), EditGesture.Move));
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldThrow_WhenRectangleLeavesPage()
    {
        await OpenAsync(objects: Region);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            Viewer.SimulateEditAsync("region", new PageRect(500, 70, 150, 80), EditGesture.Move));
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldThrow_WhenNudgingWithKeyboardEditingOff()
    {
        await OpenAsync(parameters => parameters.Add(p => p.Options, new() { KeyboardEditing = false }), Region);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Viewer.SimulateEditAsync("region", new PageRect(51, 50, 150, 80), EditGesture.Nudge));
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldThrow_WhenObjectIsLocked()
    {
        await OpenAsync(objects: Region with { Locked = true });

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Viewer.SimulateEditAsync("region", new PageRect(90, 70, 150, 80), EditGesture.Move));
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldThrow_WhenObjectIsOnAnotherPage()
    {
        await OpenAsync(objects: Region with { Page = 2 });

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Viewer.SimulateEditAsync("region", new PageRect(90, 70, 150, 80), EditGesture.Move));
    }

    [Fact]
    public async Task SimulateClickAsync_ShouldSelectObjectThenClearSelection_WhenObjectThenEmptyPageIsClicked()
    {
        var page = await OpenAsync(objects: Region);

        await Viewer.SimulateClickAsync("region");
        await Viewer.SimulateClickAsync(null);

        Assert.Equal(
            [
                new SelectionChangedArgs(2, ChangeOrigin.User, "region", 1),
                new SelectionChangedArgs(3, ChangeOrigin.User, null, 0),
            ],
            page.Instance.Events.Skip(1));
    }

    [Fact]
    public async Task SimulateDeleteKeyAsync_ShouldRemoveObjectAndClearSelectionTogether_WhenNothingDecides()
    {
        var page = await OpenAsync(objects: Region);
        await Viewer.SimulateClickAsync("region");

        await Viewer.SimulateDeleteKeyAsync("region");

        var events = page.Instance.Events.Skip(2).ToList();
        Assert.Equal(new ObjectsChangedArgs(4, [], [], [Region]), events[0], new ObjectsChangedComparer());
        Assert.Equal(new SelectionChangedArgs(4, ChangeOrigin.User, null, 0), events[1]);
        Assert.Empty(page.Instance.Objects);
    }

    [Fact]
    public async Task SimulateDeleteKeyAsync_ShouldOnlyAskHandler_WhenDeleteRequestsAreHandled()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.ConfirmDelete, true), Region);

        await Viewer.SimulateDeleteKeyAsync("region");

        Assert.Equal(new DeleteRequestedArgs(Region), page.Instance.Events.OfType<DeleteRequestedArgs>().Single());
        Assert.Single(Viewer.Objects);
    }

    [Fact]
    public async Task SimulateDeleteKeyAsync_ShouldNeitherSelectNorDelete_WhenObjectIsLocked()
    {
        await OpenAsync(objects: Region with { Locked = true });

        await Viewer.SimulateDeleteKeyAsync("region");

        Assert.Empty(Viewer.SelectedObjectIds);
        Assert.Single(Viewer.Objects);
    }

    [Fact]
    public async Task SimulateDeleteKeyAsync_ShouldSelectFocusedObject_WhenSelectOnFocusIsOn()
    {
        await OpenAsync(parameters => parameters.Add(p => p.Options, new() { SelectOnFocus = true }),
            Region with { Locked = true });

        await Viewer.SimulateDeleteKeyAsync("region");

        Assert.Equal(["region"], Viewer.SelectedObjectIds);
    }

    [Fact]
    public async Task SimulateEditAsync_ShouldKeepSelection_WhenNudgingOneOfSeveralSelectedObjects()
    {
        var other = Region with { Id = "other", Rect = new PageRect(300, 300, 50, 50) };
        var page = await OpenAsync(objects: [Region, other]);
        await page.Instance.Controller.SelectObjectsAsync(["region", "other"]);

        await Viewer.SimulateEditAsync("region", new PageRect(51, 50, 150, 80), EditGesture.Nudge);

        Assert.Equal(["region", "other"], Viewer.SelectedObjectIds);
    }

    [Fact]
    public void KeyboardScope_ShouldReachFake_WhenComponentSendsIt()
    {
        var scope = new ElementReference("panel");

        Render<PdfViewer>(parameters => parameters.Add(viewer => viewer.KeyboardScope, scope));

        Assert.Equal("panel", Viewer.KeyboardScope?.Id);
    }

    [Fact]
    public async Task MoveObjectByAsync_ShouldFail_WhenObjectIdIsUnknown()
    {
        var page = await OpenAsync();

        await Assert.ThrowsAsync<JSException>(() => page.Instance.Controller.MoveObjectByAsync("missing", 1, 0));
    }

    [Fact]
    public async Task MoveObjectByAsync_ShouldWaitForDocument_WhenIssuedWhileOpening()
    {
        var page = await RenderWithObjectsAsync(Region);

        var moving = page.Instance.Controller.MoveObjectByAsync("region", 10, 0);
        var movedBeforeLoad = moving.IsCompleted;
        await Viewer.LoadDocumentAsync(pageCount: 3);
        await moving;

        Assert.False(movedBeforeLoad);
        Assert.Equal(new PageRect(60, 50, 150, 80), Assert.Single(Viewer.Objects).Rect);
    }

    [Fact]
    public async Task GetPageInfoAsync_ShouldWaitForDocument_WhenIssuedWhileOpening()
    {
        var page = Render<ApplicationPage>();

        var info = page.Instance.Controller.GetPageInfoAsync(2);
        var answeredBeforeLoad = info.IsCompleted;
        await Viewer.LoadDocumentAsync(pageCount: 3);

        Assert.False(answeredBeforeLoad);
        Assert.Equal(new PageInfo(2, null, 612, 792, PageRotation.None), await info);
    }

    [Fact]
    public async Task CopyDocumentToAsync_ShouldThrow_WhenDocumentExceedsMaximumSize()
    {
        var page = await OpenAsync();
        Viewer.DocumentBytes = new byte[10];
        using var destination = new MemoryStream();

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            page.Instance.Controller.CopyDocumentToAsync(destination, maximumSize: 5));
    }

    [Fact]
    public async Task GetPageInfoAsync_ShouldFail_WhenPageIsOutOfRange()
    {
        var page = await OpenAsync();

        await Assert.ThrowsAsync<JSException>(() => page.Instance.Controller.GetPageInfoAsync(4));
    }

    [Fact]
    public async Task ScrollObjectIntoViewAsync_ShouldOpenOnObjectsPage_WhenIssuedWhileOpening()
    {
        var page = await RenderWithObjectsAsync(Region with { Page = 2 });

        var scrolling = page.Instance.Controller.ScrollObjectIntoViewAsync("region");
        await Viewer.LoadDocumentAsync(pageCount: 3);
        await scrolling;

        Assert.Equal([new DocumentLoadedArgs(3), 2], page.Instance.Events);
    }

    [Fact]
    public async Task SetToolAsync_ShouldFail_WhenDrawDefaultsHaveBadAppDataKey()
    {
        var page = await OpenAsync();
        var defaults = new ViewerDrawDefaults { AppData = new Dictionary<string, string> { ["Section"] = "1" } };

        await Assert.ThrowsAsync<JSException>(() =>
            page.Instance.Controller.SetToolAsync(ViewerTool.DrawRectangle, defaults));
    }

    [Fact]
    public async Task ApplyObjects_ShouldKeepUserEdit_WhenBatchIsBasedOnOlderSequence()
    {
        var page = await OpenAsync(objects: Region);
        var moved = new PageRect(90, 70, 150, 80);
        await Viewer.SimulateEditAsync("region", moved, EditGesture.Move);

        // The application hadn't heard of the move, at sequence 3, when it sent this batch.
        await page.InvokeAsync(() => ((IViewerBackend)Viewer).ApplyObjectsAsync(new ObjectBatch([Region], [], 1)));

        Assert.Equal(moved, Assert.Single(Viewer.Objects).Rect);
    }

    [Fact]
    public async Task ApplyObjects_ShouldReplaceUserEdit_WhenBatchIsBasedOnIt()
    {
        var page = await OpenAsync(objects: Region);
        await Viewer.SimulateEditAsync("region", new PageRect(90, 70, 150, 80), EditGesture.Move);

        await page.InvokeAsync(() => ((IViewerBackend)Viewer).ApplyObjectsAsync(new ObjectBatch([Region], [], 3)));

        Assert.Equal(Region.Rect, Assert.Single(Viewer.Objects).Rect);
    }

    [Fact]
    public void SelectedObjectId_ShouldBecomeNull_WhenViewerHasNoSuchObject()
    {
        var reported = new List<string?>();

        Render<PdfViewer>(parameters => parameters
            .Add(viewer => viewer.SelectedObjectId, "missing")
            .Add(viewer => viewer.SelectedObjectIdChanged, (string? id) => reported.Add(id)));

        Assert.Equal([null], reported);
    }

    [Fact]
    public async Task DisposeAsync_ShouldDiscardDraft_WhenItsHandlerIsStillRunning()
    {
        var page = await OpenAsync(parameters => parameters.Add(p => p.ConfirmDraw, true));
        await DrawHeadingsAsync(page);
        var viewer = Viewer;
        _ = viewer.SimulateDrawAsync(new PageRect(10, 20, 100, 40));
        page.WaitForAssertion(() => Assert.Single(viewer.Drafts));

        await DisposeComponentsAsync();

        Assert.True(viewer.IsDisposed);
        Assert.Empty(viewer.Drafts);
    }

    [Fact]
    public async Task MoveObjectByAsync_ShouldReportNudgeAsUserChange_WhenObjectExists()
    {
        var page = await OpenAsync(objects: Region);

        await page.Instance.Controller.MoveObjectByAsync("region", 10, 0);

        var update = Assert.Single(page.Instance.Events.OfType<ObjectsChangedArgs>().Single().Updated);
        Assert.Equal((new PageRect(60, 50, 150, 80), EditGesture.Nudge), (update.Object.Rect, update.Gesture));
    }

    [Fact]
    public async Task SettleAsync_ShouldDeliverClearedSelection_WhenApplicationRemovesSelectedObject()
    {
        var page = await OpenAsync(objects: Region);
        await page.Instance.Controller.SelectObjectAsync("region");
        page.Instance.Objects.Clear();

        await page.InvokeAsync(page.Instance.Refresh);
        await Viewer.SettleAsync();

        Assert.Equal(new SelectionChangedArgs(3, ChangeOrigin.Api, null, 0), page.Instance.Events[^1]);
    }

    [Fact]
    public async Task Commands_ShouldRecordZoom_WhenControllerSetsIt()
    {
        var page = await OpenAsync();

        await page.Instance.Controller.SetZoomAsync(ViewerZoomMode.FitPage);

        var command = Assert.Single(Viewer.Commands);
        Assert.Equal(nameof(PdfViewerController.SetZoomAsync), command.Name);
        Assert.Equal([ViewerZoomMode.FitPage], command.Arguments);
    }

    [Fact]
    public async Task Commands_ShouldRecordAnnouncement_WhenControllerAnnounces()
    {
        var page = await OpenAsync();

        await page.Instance.Controller.AnnounceAsync("Heading moved back");

        var command = Assert.Single(Viewer.Commands);
        Assert.Equal(nameof(PdfViewerController.AnnounceAsync), command.Name);
        Assert.Equal(["Heading moved back"], command.Arguments);
    }

    [Fact]
    public void Viewer_ShouldThrow_WhenNoViewerHasRendered()
    {
        Assert.Throws<InvalidOperationException>(() => _viewers.Viewer);
    }

    /// <summary>Compares the lists inside, which records compare by reference.</summary>
    private sealed class ObjectsChangedComparer : IEqualityComparer<object>
    {
        public new bool Equals(object? x, object? y) =>
            x is ObjectsChangedArgs first && y is ObjectsChangedArgs second && first.Sequence == second.Sequence &&
            first.Added.SequenceEqual(second.Added) && first.Updated.SequenceEqual(second.Updated) &&
            first.Removed.SequenceEqual(second.Removed);

        public int GetHashCode(object obj) => 0;
    }
}
