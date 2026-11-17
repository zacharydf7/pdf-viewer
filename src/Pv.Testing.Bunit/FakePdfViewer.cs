using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using Pv.Blazor;

namespace Pv.Testing.Bunit;

/// <summary>
/// A command the application sent through <see cref="PdfViewerController"/>. <see cref="Name"/> is the controller
/// method's name, such as <c>nameof(PdfViewerController.SetZoomAsync)</c>.
/// </summary>
public sealed record FakeViewerCommand(string Name, IReadOnlyList<object?> Arguments);

/// <summary>
/// Stands in for the browser side of one <see cref="PdfViewer"/> in a component test, such as one written with bUnit.
/// It keeps the viewer's objects, drafts, selection, tool and read-only state in memory and applies the same rules as
/// the real viewer, so the component raises the same events, in the same order and with the same sequence numbers.
/// </summary>
/// <remarks>
/// A document doesn't open by itself: after the component sends a source, call <see cref="LoadDocumentAsync"/> or
/// <see cref="FailDocumentAsync"/>. The <c>Simulate</c> methods act as the user does and complete once the component
/// has handled what they caused, including any handler that waits, such as on a dialog. They throw when the user
/// couldn't do what they ask, such as moving a locked object or drawing while the viewer is read-only, so a test can't
/// pass on something that can't happen. As in the browser, commands that name an object the viewer doesn't have, or
/// that the viewer refuses, fail with a <see cref="JSException"/>, and commands that need a document wait for one that
/// is opening.
/// </remarks>
public sealed partial class FakePdfViewer : IViewerBackend
{
    private const double MinimumDrawSize = 2;
    private const double MinimumEditSize = 1;

    private readonly ViewerNotifications _notifications;
    private readonly OrderedDictionary<string, ViewerObject> _objects = [];
    private readonly OrderedDictionary<string, ViewerObject> _drafts = [];
    /// <summary>The drafts whose <see cref="PdfViewer.OnObjectDrawn"/> handler is still running.</summary>
    private readonly HashSet<string> _heldDrafts = [];
    /// <summary>The sequence of the user's latest change to each object, for batches based on an older one.</summary>
    private readonly Dictionary<string, long> _userChanges = [];
    private readonly List<FakeViewerCommand> _commands = [];
    private List<string> _selected = [];
    private ViewerSubscriptions _subscriptions;
    private long _sequence;
    /// <summary>
    /// The change waiting to go to the component, which gets one notification per user action or command.
    /// </summary>
    private ChangesNotification? _pending;
    /// <summary>Like the browser's, this starts at 1 and outlives documents.</summary>
    private int _pageNumber = 1;
    private int _openingPage;
    private int? _requestedPage;
    /// <summary>Completes when the document being opened has loaded, failed or been replaced.</summary>
    private TaskCompletionSource _opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _opening;
    /// <summary>
    /// Notifications sent after the call that caused them returned, which may not have been handled yet.
    /// </summary>
    private Task _sent = Task.CompletedTask;

    internal FakePdfViewer(ViewerNotifications notifications, PdfViewerOptions options,
        ViewerSubscriptions subscriptions)
    {
        _notifications = notifications;
        Options = options;
        _subscriptions = subscriptions;
    }

    public PdfViewerOptions Options { get; private set; }

    /// <summary>The source the component asked for, or null when it closed the document or never set one.</summary>
    public PdfSource? Source { get; private set; }

    /// <summary>
    /// Whether the component has sent a source that <see cref="LoadDocumentAsync"/> or
    /// <see cref="FailDocumentAsync"/> hasn't answered yet.
    /// </summary>
    public bool IsOpening => _opening;

    public bool IsDocumentOpen => PageCount > 0;

    /// <summary>The open document's number of pages, or 0 when none is open.</summary>
    public int PageCount { get; private set; }

    /// <summary>The displayed page, or 0 when no document is open.</summary>
    public int CurrentPage => IsDocumentOpen ? _pageNumber : 0;

    /// <summary>The size of every page, in the coordinates objects use. US Letter unless a test sets another.</summary>
    public double PageWidth { get; set; } = 612;

    /// <inheritdoc cref="PageWidth"/>
    public double PageHeight { get; set; } = 792;

    /// <summary>
    /// The bytes <see cref="PdfViewerController.CopyDocumentToAsync"/> copies while a document is open.
    /// </summary>
    public byte[] DocumentBytes { get; set; } = [];

    /// <summary>Every object, in the order added.</summary>
    public IReadOnlyList<ViewerObject> Objects => [.. _objects.Values];

    /// <summary>
    /// The objects the user has drawn that are still waiting on <see cref="PdfViewer.OnObjectDrawn"/>.
    /// </summary>
    public IReadOnlyList<ViewerObject> Drafts => [.. _drafts.Values];

    /// <summary>The selected objects' IDs, in the order selected.</summary>
    public IReadOnlyList<string> SelectedObjectIds => [.. _selected];

    public ViewerTool Tool { get; private set; } = ViewerTool.Select;

    public ViewerDrawDefaults? DrawDefaults { get; private set; }

    public bool ReadOnly { get; private set; }

    /// <summary>The element the component sent as <see cref="PdfViewer.KeyboardScope"/>, or null for none.</summary>
    public ElementReference? KeyboardScope { get; private set; }

    /// <summary>
    /// The commands the application sent through the controller, in the order the viewer received them.
    /// </summary>
    public IReadOnlyList<FakeViewerCommand> Commands => _commands;

    public bool IsDisposed { get; private set; }

    /// <summary>
    /// Finishes opening the document the component asked for, as the browser does once it has read it, and completes
    /// when the component has handled that. It opens on the page the component asked for, or the one a page turn
    /// asked for meanwhile.
    /// </summary>
    public Task LoadDocumentAsync(int pageCount = 1) => ActAsync(async notifications =>
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(pageCount, 1);
        RequireOpening();
        _opening = false;
        PageCount = pageCount;
        var previousPage = _pageNumber;
        _pageNumber = Math.Clamp(_requestedPage ?? _openingPage, 1, pageCount);
        await notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(pageCount, _pageNumber));
        if (_pageNumber != previousPage)
        {
            await notifications.NotifyPageChanged(new PageChangedArgs(_pageNumber));
        }
        _opened.TrySetResult();
    });

    /// <summary>Fails the document the component asked for, as the browser does when it can't open it.</summary>
    public Task FailDocumentAsync(ViewerErrorCode code = ViewerErrorCode.InvalidPdf,
        string message = "The document couldn't be opened.") => ActAsync(async notifications =>
    {
        RequireOpening();
        _opening = false;
        _opened.TrySetResult();
        await notifications.NotifyError(new ViewerError(code, message, DocumentClosed: true));
    });

    /// <summary>
    /// Reports an error that leaves the open document as it is, as the browser does when a page fails to load or paint.
    /// </summary>
    public Task ReportErrorAsync(ViewerErrorCode code = ViewerErrorCode.Render,
        string message = "The page couldn't be painted.") => ActAsync(async notifications =>
    {
        RequireDocument();
        await notifications.NotifyError(new ViewerError(code, message, DocumentClosed: false));
    });

    /// <summary>
    /// Draws a rectangle on the displayed page with the draw tool, and returns the new object's ID. With an
    /// <see cref="PdfViewer.OnObjectDrawn"/> handler, the object stays a draft until the handler finishes, and this
    /// completes after that.
    /// </summary>
    public async Task<string> SimulateDrawAsync(PageRect rect)
    {
        string? id = null;
        await ActAsync(async notifications => id = await DrawAsync(notifications, rect));
        return id!;
    }

    private async Task<string> DrawAsync(ViewerNotifications notifications, PageRect rect)
    {
        RequireDocument();
        if (Tool != ViewerTool.DrawRectangle || ReadOnly)
        {
            throw new InvalidOperationException(ReadOnly
                ? "The viewer is read-only, so the user can't draw."
                : $"The user draws with the draw tool, but the tool is {Tool}.");
        }
        if (rect.Width < MinimumDrawSize || rect.Height < MinimumDrawSize || rect.X < 0 || rect.Y < 0 ||
            rect.X + rect.Width > PageWidth || rect.Y + rect.Height > PageHeight)
        {
            throw new ArgumentException(
                $"A drawn rectangle must be at least {MinimumDrawSize} units each way and lie on the page.",
                nameof(rect));
        }
        var defaults = DrawDefaults;
        var drawn = new ViewerObject(Guid.NewGuid().ToString(), _pageNumber, Round(rect))
        {
            Kind = defaults?.Kind,
            Label = defaults?.Label,
            CssClass = defaults?.CssClass,
            AppData = defaults?.AppData,
            Style = defaults?.Style,
        };
        _drafts[drawn.Id] = drawn;
        if (!_subscriptions.Drawn)
        {
            CommitDraft(drawn.Id);
            await SendPendingAsync(notifications);
            return drawn.Id;
        }
        _heldDrafts.Add(drawn.Id);
        await notifications.NotifyObjectDrawn(new ObjectDrawnNotification(drawn));
        // A draft still there once the handler has finished wasn't kept.
        _heldDrafts.Remove(drawn.Id);
        _drafts.Remove(drawn.Id);
        return drawn.Id;
    }

    /// <summary>
    /// Clicks an object, which selects it, or empty page area when given null, which clears the selection unless the
    /// viewer is read-only.
    /// </summary>
    public Task SimulateClickAsync(string? id) => ActAsync(async notifications =>
    {
        RequireDocument();
        RequirePointerTool();
        if (id is null)
        {
            if (!ReadOnly)
            {
                Select([], ChangeOrigin.User);
            }
        }
        else
        {
            RequireReachable(id);
            Select([id], ChangeOrigin.User);
        }
        await SendPendingAsync(notifications);
    });

    /// <summary>
    /// Changes an object's rectangle as the user does with a gesture. <see cref="EditGesture.Move"/> drags the object,
    /// which selects it first. <see cref="EditGesture.Resize"/> drags a handle, which an object has only while it's
    /// the one object selected. <see cref="EditGesture.Nudge"/> holds the move modifier and presses arrow keys, on the
    /// focused object or in <see cref="KeyboardScope"/>. That selects the object unless it's selected already, and
    /// needs keyboard editing on. The rectangle is the one the gesture ends with: on the page, at least one unit each
    /// way, and for a move or nudge the same size as before.
    /// </summary>
    public Task SimulateEditAsync(string id, PageRect rect, EditGesture gesture) => ActAsync(async notifications =>
    {
        RequireDocument();
        RequirePointerTool();
        var target = RequireReachable(id);
        if (target.Locked)
        {
            throw new InvalidOperationException($"Object \"{id}\" is locked, so the user can't change it.");
        }
        if (rect.Width < MinimumEditSize || rect.Height < MinimumEditSize || rect.X < 0 || rect.Y < 0 ||
            rect.X + rect.Width > PageWidth || rect.Y + rect.Height > PageHeight)
        {
            throw new ArgumentException(
                $"An edited rectangle must be at least {MinimumEditSize} unit each way and lie on the page.",
                nameof(rect));
        }
        if (gesture != EditGesture.Resize && (rect.Width, rect.Height) != (target.Rect.Width, target.Rect.Height))
        {
            throw new ArgumentException(
                $"A {gesture.ToString().ToLowerInvariant()} keeps the object's size; only a resize changes it.",
                nameof(rect));
        }
        switch (gesture)
        {
            case EditGesture.Resize when _selected is not [var only] || only != id:
                throw new InvalidOperationException(
                    $"Object \"{id}\" has resize handles only while it's the one object selected.");
            case EditGesture.Nudge when !Options.KeyboardEditing:
                throw new InvalidOperationException("Keyboard editing is off, so arrow keys don't move objects.");
            case EditGesture.Move:
            case EditGesture.Nudge when !_selected.Contains(id):
                Select([id], ChangeOrigin.User);
                await SendPendingAsync(notifications);
                break;
        }
        var edited = target with { Rect = Round(rect) };
        if (edited != target)
        {
            Commit([], [new ObjectUpdate(edited, target, gesture)], [], ChangeOrigin.User);
            await SendPendingAsync(notifications);
        }
    });

    /// <summary>
    /// Focuses an object and presses Delete, which needs keyboard editing on. Focusing selects the object only with
    /// <see cref="PdfViewerOptions.SelectOnFocus"/> on, and a locked object isn't deleted. With a
    /// <see cref="PdfViewer.OnDeleteRequested"/> handler, the handler decides, and this completes once it has finished.
    /// </summary>
    public Task SimulateDeleteKeyAsync(string id) => ActAsync(async notifications =>
    {
        RequireDocument();
        RequirePointerTool();
        var target = RequireReachable(id);
        if (!Options.KeyboardEditing)
        {
            throw new InvalidOperationException("Keyboard editing is off, so the Delete key doesn't delete objects.");
        }
        if (Options.SelectOnFocus)
        {
            Select([id], ChangeOrigin.User);
            await SendPendingAsync(notifications);
        }
        if (target.Locked)
        {
            return;
        }
        if (_subscriptions.DeleteRequested)
        {
            await notifications.NotifyDeleteRequested(new DeleteRequestedArgs(target));
        }
        else
        {
            Commit([], [], [target], ChangeOrigin.User);
            await SendPendingAsync(notifications);
        }
    });

    /// <summary>
    /// Completes once the component has handled every notification sent so far, including those that the
    /// application's own changes caused, such as a selection that a removed object ended.
    /// </summary>
    public async Task SettleAsync()
    {
        Task sent;
        do
        {
            sent = _sent;
            await sent;
        } while (sent != _sent);
    }

    Task IViewerBackend.ConfigureAsync(PdfViewerOptions options) => Change(() => Options = options);

    Task IViewerBackend.SubscribeAsync(ViewerSubscriptions subscriptions) =>
        Change(() => _subscriptions = subscriptions);

    Task IViewerBackend.SetReadOnlyAsync(bool readOnly) => Change(() => ReadOnly = readOnly);

    Task IViewerBackend.SetKeyboardScopeAsync(ElementReference? scope) => Change(() => KeyboardScope = scope);

    Task IViewerBackend.OpenAsync(PdfSource source, int initialPage) => Change(() =>
    {
        CloseDocument();
        Source = source;
        _opening = true;
        _openingPage = initialPage;
        _requestedPage = null;
    });

    Task IViewerBackend.CloseAsync() => Change(() =>
    {
        CloseDocument();
        Source = null;
    });

    Task IViewerBackend.ApplyObjectsAsync(ObjectBatch batch) => Change(() => Apply(batch, ChangeOrigin.Api));

    async Task<bool> IViewerBackend.SelectObjectIfPresentAsync(string? id)
    {
        var present = false;
        await Change(() =>
        {
            present = id is null || _objects.ContainsKey(id);
            Select(present && id is not null ? [id] : [], ChangeOrigin.Api);
        });
        return present;
    }

    Task IViewerBackend.GoToPageAsync(int page, CancellationToken cancellationToken) =>
        CommandAsync(nameof(PdfViewerController.GoToPageAsync), [page],
            notifications => TurnToAsync(notifications, page, cancellationToken));

    Task IViewerBackend.SetZoomAsync(double scale) => Record(nameof(PdfViewerController.SetZoomAsync), scale);

    Task IViewerBackend.SetZoomAsync(ViewerZoomMode mode) => Record(nameof(PdfViewerController.SetZoomAsync), mode);

    Task IViewerBackend.ZoomByAsync(double factor) => Record(nameof(PdfViewerController.ZoomByAsync), factor);

    Task IViewerBackend.SetRotationAsync(int degrees) =>
        Record(nameof(PdfViewerController.SetRotationAsync), (PageRotation)degrees);

    Task IViewerBackend.RotateByAsync(int degrees) => Record(nameof(PdfViewerController.RotateByAsync), degrees);

    Task IViewerBackend.SetPageRotationAsync(int page, int? degrees) =>
        Record(nameof(PdfViewerController.SetPageRotationAsync), page, (PageRotation?)degrees);

    Task IViewerBackend.AnnounceAsync(string message) => Record(nameof(PdfViewerController.AnnounceAsync), message);

    Task IViewerBackend.ScrollObjectIntoViewAsync(string id, CancellationToken cancellationToken) =>
        CommandAsync(nameof(PdfViewerController.ScrollObjectIntoViewAsync), [id], async notifications =>
        {
            if (RequireObject(id).Page is { } page && (_opening || page != _pageNumber))
            {
                await TurnToAsync(notifications, page, cancellationToken);
            }
        });

    async Task<PageInfo> IViewerBackend.GetPageInfoAsync(int page, CancellationToken cancellationToken)
    {
        await CommandAsync(nameof(PdfViewerController.GetPageInfoAsync), [page], async _ =>
        {
            await WaitForDocumentAsync(cancellationToken);
            if (page < 1 || page > PageCount)
            {
                throw new JSException($"Page must be from 1 to {PageCount}, but was {page}.");
            }
        });
        return new PageInfo(page, null, PageWidth, PageHeight, PageRotation.None);
    }

    Task IViewerBackend.SetToolAsync(ViewerTool tool, ViewerDrawDefaults? drawDefaults) =>
        CommandAsync(nameof(PdfViewerController.SetToolAsync), [tool, drawDefaults], _ =>
        {
            CheckAppData(drawDefaults?.AppData);
            Tool = tool;
            DrawDefaults = drawDefaults;
            return Task.CompletedTask;
        });

    Task IViewerBackend.CopyDocumentToAsync(Stream destination, long maximumSize,
        CancellationToken cancellationToken) =>
        CommandAsync(nameof(PdfViewerController.CopyDocumentToAsync), [destination], async _ =>
        {
            await WaitForDocumentAsync(cancellationToken);
            if (DocumentBytes.Length > maximumSize)
            {
                throw new ArgumentOutOfRangeException(nameof(maximumSize),
                    $"The document is {DocumentBytes.Length} bytes, more than the {maximumSize} allowed.");
            }
            await destination.WriteAsync(DocumentBytes, cancellationToken);
        });

    Task IViewerBackend.MoveObjectByAsync(string id, double deltaX, double deltaY) =>
        CommandAsync(nameof(PdfViewerController.MoveObjectByAsync), [id, deltaX, deltaY], async notifications =>
        {
            RequireObject(id);
            await WaitForDocumentAsync(CancellationToken.None);
            var target = RequireObject(id);
            if (target.Locked || target.Hidden)
            {
                return;
            }
            var rect = target.Rect;
            var x = Math.Clamp(rect.X + deltaX, 0, Math.Max(PageWidth - rect.Width, 0));
            var y = Math.Clamp(rect.Y + deltaY, 0, Math.Max(PageHeight - rect.Height, 0));
            var moved = target with { Rect = Round(rect with { X = x, Y = y }) };
            if (moved != target)
            {
                Commit([], [new ObjectUpdate(moved, target, EditGesture.Nudge)], [], ChangeOrigin.User);
                await SendPendingAsync(notifications);
            }
        });

    Task IViewerBackend.CommitDraftAsync(string id) =>
        CommandAsync(nameof(PdfViewerController.CommitDraftAsync), [id], async notifications =>
        {
            CommitDraft(id);
            await SendPendingAsync(notifications);
        });

    Task IViewerBackend.DiscardDraftAsync(string id) =>
        CommandAsync(nameof(PdfViewerController.DiscardDraftAsync), [id], _ =>
        {
            _drafts.Remove(id);
            return Task.CompletedTask;
        });

    Task IViewerBackend.SelectObjectsAsync(IEnumerable<string> ids)
    {
        var list = ids.ToList();
        return CommandAsync(nameof(PdfViewerController.SelectObjectsAsync), [list], async notifications =>
        {
            Select(list, ChangeOrigin.Api);
            await SendPendingAsync(notifications);
        });
    }

    async Task<IReadOnlyList<string>> IViewerBackend.GetSelectedObjectIdsAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<string> ids = [];
        await CommandAsync(nameof(PdfViewerController.GetSelectedObjectIdsAsync), [], _ =>
        {
            ids = SelectedObjectIds;
            return Task.CompletedTask;
        });
        return ids;
    }

    /// <summary>Discards the drafts whose handlers were still running, as the browser does.</summary>
    ValueTask IAsyncDisposable.DisposeAsync()
    {
        IsDisposed = true;
        foreach (var id in _heldDrafts)
        {
            _drafts.Remove(id);
        }
        _heldDrafts.Clear();
        _pending = null;
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Applies a change the component sends. Any notification it causes goes once the call has returned, as the
    /// browser's does.
    /// </summary>
    private Task Change(Action change) => DispatchAsync(_ =>
    {
        change();
        if (TakePending() is { } pending)
        {
            Send(pending);
        }
        return Task.CompletedTask;
    });

    private Task Record(string name, params object?[] arguments) =>
        CommandAsync(name, arguments, _ => Task.CompletedTask);

    /// <summary>Records and runs a command, which completes once the component has handled what it caused.</summary>
    private Task CommandAsync(string name, object?[] arguments, Func<ViewerNotifications, Task> command) =>
        DispatchAsync(async notifications =>
        {
            ThrowIfDisposed();
            _commands.Add(new FakeViewerCommand(name, arguments));
            await command(notifications);
        });

    /// <summary>
    /// Runs something the user or the browser does, and completes once the component has handled all it caused,
    /// including notifications that the application's own changes caused meanwhile.
    /// </summary>
    private Task ActAsync(Func<ViewerNotifications, Task> action) => DispatchAsync(async notifications =>
    {
        await action(notifications);
        await SettleAsync();
    });

    private Task DispatchAsync(Func<ViewerNotifications, Task> work) =>
        _notifications.DispatchAsync(async notifications =>
        {
            ThrowIfDisposed();
            await work(notifications);
        });

    /// <summary>
    /// Sends a notification after the current call has returned, and tracks it for <see cref="SettleAsync"/>.
    /// </summary>
    private void Send(ChangesNotification pending)
    {
        _sent = Task.WhenAll(_sent, SendLaterAsync());

        async Task SendLaterAsync()
        {
            await Task.Yield();
            await _notifications.DispatchAsync(notifications => notifications.NotifyChanges(pending));
        }
    }

    private async Task SendPendingAsync(ViewerNotifications notifications)
    {
        if (TakePending() is { } pending)
        {
            await notifications.NotifyChanges(pending);
        }
    }

    private ChangesNotification? TakePending()
    {
        var pending = _pending;
        _pending = null;
        return pending;
    }

    /// <summary>The notification that will carry this change, so changes made together arrive together.</summary>
    private ChangesNotification Pending(long sequence) =>
        _pending = (_pending ?? new ChangesNotification(sequence, null, null)) with { Sequence = sequence };

    /// <summary>
    /// Applies a batch as the browser's store does, leaving alone objects the user changed after the sequence the batch
    /// is based on.
    /// </summary>
    private void Apply(ObjectBatch batch, ChangeOrigin origin)
    {
        var ids = batch.Upsert.Select(viewerObject => viewerObject.Id).ToHashSet();
        if (ids.Count != batch.Upsert.Count)
        {
            throw new JSException("Object IDs must be unique.");
        }
        if (batch.Remove.FirstOrDefault(ids.Contains) is { } both)
        {
            throw new JSException($"Object \"{both}\" can't be both upserted and removed.");
        }
        foreach (var viewerObject in batch.Upsert)
        {
            CheckAppData(viewerObject.AppData);
        }
        bool ChangedSince(string id) => _userChanges.GetValueOrDefault(id) > batch.BasedOn;

        var added = new List<ViewerObject>();
        var updated = new List<ObjectUpdate>();
        foreach (var incoming in batch.Upsert.Where(viewerObject => !ChangedSince(viewerObject.Id)))
        {
            if (!_objects.TryGetValue(incoming.Id, out var previous))
            {
                added.Add(incoming);
            }
            else if (previous != incoming)
            {
                updated.Add(new ObjectUpdate(incoming, previous));
            }
        }
        var removed = batch.Remove.Distinct().Where(id => !ChangedSince(id))
            .Select(id => _objects.GetValueOrDefault(id)).OfType<ViewerObject>().ToList();
        foreach (var (id, changed) in _userChanges.ToList())
        {
            if (changed <= batch.BasedOn)
            {
                _userChanges.Remove(id);
            }
        }
        Commit(added, updated, removed, origin);
    }

    /// <summary>
    /// Stores a change and reports it once. Removed objects leave the selection first, as a change of its own, and
    /// drafts the change committed are resolved after it.
    /// </summary>
    private void Commit(IReadOnlyList<ViewerObject> added, IReadOnlyList<ObjectUpdate> updated,
        IReadOnlyList<ViewerObject> removed, ChangeOrigin origin)
    {
        if (added.Count + updated.Count + removed.Count == 0)
        {
            return;
        }
        var gone = removed.Select(viewerObject => viewerObject.Id).ToHashSet();
        if (_selected.Any(gone.Contains))
        {
            Select([.. _selected.Where(id => !gone.Contains(id))], origin);
        }
        var committed = added.Where(viewerObject => _drafts.Remove(viewerObject.Id)).ToList();
        var sequence = ++_sequence;
        foreach (var viewerObject in removed)
        {
            _objects.Remove(viewerObject.Id);
        }
        foreach (var viewerObject in added.Concat(updated.Select(update => update.Object)))
        {
            _objects[viewerObject.Id] = viewerObject;
        }
        if (origin == ChangeOrigin.User)
        {
            foreach (var id in gone.Concat(added.Concat(updated.Select(update => update.Object)).Select(o => o.Id)))
            {
                _userChanges[id] = sequence;
            }
            if (_subscriptions.Objects)
            {
                var pending = Pending(sequence);
                var objects = pending.Objects ?? new ObjectChanges([], [], []);
                _pending = pending with
                {
                    Objects = new ObjectChanges([.. objects.Added, .. added], [.. objects.Updated, .. updated],
                        [.. objects.Removed, .. removed]),
                };
            }
        }
        foreach (var draft in committed)
        {
            // The application may have kept it hidden or unselectable, and then it isn't selected.
            if (Options.SelectOnCreate && _objects.GetValueOrDefault(draft.Id) is { Selectable: true, Hidden: false })
            {
                Select([draft.Id], ChangeOrigin.User);
            }
        }
    }

    private void CommitDraft(string id)
    {
        if (_drafts.TryGetValue(id, out var draft))
        {
            Commit([draft], [], [], ChangeOrigin.User);
        }
    }

    /// <summary>Selects exactly these objects. A repeated ID counts once, at its first position.</summary>
    private void Select(IReadOnlyList<string> ids, ChangeOrigin origin)
    {
        var selected = ids.Distinct().ToList();
        foreach (var id in selected)
        {
            RequireObject(id);
        }
        if (selected.SequenceEqual(_selected))
        {
            return;
        }
        _selected = selected;
        var sequence = ++_sequence;
        if (_subscriptions.Selection)
        {
            _pending = Pending(sequence) with
            {
                Selection = new SelectionState(origin, selected.LastOrDefault(), selected.Count),
            };
        }
    }

    /// <summary>
    /// Removes every object and draft, and forgets which objects the user changed, as closing a document does in the
    /// browser.
    /// </summary>
    private void CloseDocument()
    {
        Commit([], [], [.. _objects.Values], ChangeOrigin.Api);
        _userChanges.Clear();
        _drafts.Clear();
        _heldDrafts.Clear();
        PageCount = 0;
        _opening = false;
        _opened.TrySetResult();
        _opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    /// <summary>Rounds to whole units, keeping the rectangle on the page, when the options ask for it.</summary>
    private PageRect Round(PageRect rect)
    {
        if (!Options.RoundCoordinates)
        {
            return rect;
        }
        var x = Math.Clamp(JsRound(rect.X), 0, PageWidth);
        var y = Math.Clamp(JsRound(rect.Y), 0, PageHeight);
        var right = Math.Min(JsRound(rect.X + rect.Width), Math.Floor(PageWidth));
        var bottom = Math.Min(JsRound(rect.Y + rect.Height), Math.Floor(PageHeight));
        return new PageRect(x, y, Math.Max(right - x, 0), Math.Max(bottom - y, 0));
    }

    /// <summary>JavaScript's Math.round, which rounds halves up rather than to even.</summary>
    private static double JsRound(double value) => Math.Floor(value + 0.5);

    private static void CheckAppData(IReadOnlyDictionary<string, string>? appData)
    {
        foreach (var key in appData?.Keys ?? [])
        {
            if (!AppDataKey().IsMatch(key))
            {
                throw new JSException($"App data key \"{key}\" must start with a lowercase letter and " +
                    "contain only lowercase letters, digits and hyphens.");
            }
        }
    }

    [GeneratedRegex("^[a-z][a-z0-9-]*$")]
    private static partial Regex AppDataKey();

    /// <summary>An object a command names, which fails in the browser if there's no such object.</summary>
    private ViewerObject RequireObject(string id) => _objects.GetValueOrDefault(id)
        ?? throw new JSException($"No object with ID \"{id}\" exists.");

    /// <summary>An object the user can point at and act on, on the displayed page.</summary>
    private ViewerObject RequireReachable(string id)
    {
        var target = _objects.GetValueOrDefault(id)
            ?? throw new InvalidOperationException($"No object with ID \"{id}\" exists.");
        var reason = target switch
        {
            { Page: { } page } when page != _pageNumber => $"is on page {page}, but page {_pageNumber} is displayed",
            { Hidden: true } => "is hidden",
            { Selectable: false } => "isn't selectable",
            { EditableWhenReadOnly: false } when ReadOnly => "isn't editable while the viewer is read-only",
            _ => null,
        };
        return reason is null
            ? target
            : throw new InvalidOperationException($"Object \"{id}\" {reason}, so the user can't reach it.");
    }

    /// <summary>Clicking and editing objects needs the select tool, which read-only mode also gives.</summary>
    private void RequirePointerTool()
    {
        if (!ReadOnly && Tool != ViewerTool.Select)
        {
            throw new InvalidOperationException(
                $"The user acts on objects with the select tool, but the tool is {Tool}.");
        }
    }

    /// <summary>
    /// Turns to a page, or while a document is opening, makes it open on that page and waits for it, as the browser
    /// does.
    /// </summary>
    private async Task TurnToAsync(ViewerNotifications notifications, int page, CancellationToken cancellationToken)
    {
        if (_opening)
        {
            _requestedPage = page;
            await _opened.Task.WaitAsync(cancellationToken);
        }
        else if (IsDocumentOpen && Math.Clamp(page, 1, PageCount) is var shown && shown != _pageNumber)
        {
            _pageNumber = shown;
            await notifications.NotifyPageChanged(new PageChangedArgs(shown));
        }
    }

    /// <summary>Waits for a document that is opening, and fails as the browser does if none is open then.</summary>
    private async Task WaitForDocumentAsync(CancellationToken cancellationToken)
    {
        if (_opening)
        {
            await _opened.Task.WaitAsync(cancellationToken);
        }
        if (!IsDocumentOpen)
        {
            throw new JSException("No document is open.");
        }
    }

    private void RequireDocument()
    {
        if (!IsDocumentOpen)
        {
            throw new InvalidOperationException("No document is open. Set a source and call LoadDocumentAsync first.");
        }
    }

    private void RequireOpening()
    {
        if (!_opening)
        {
            throw new InvalidOperationException("No document is opening. Give the viewer a source first.");
        }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(IsDisposed, this);
}
