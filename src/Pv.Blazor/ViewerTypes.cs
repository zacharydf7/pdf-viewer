using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pv.Blazor;

/// <summary>
/// A rectangle on a page. By default it's in page space: PDF user-space units, measured from the top-left corner of the
/// unrotated crop box, with y growing downward, and it stays attached to the page's content at any zoom or rotation.
/// With <see cref="ViewerCoordinates.Display"/>, it's measured against the page as presented instead.
/// </summary>
public readonly record struct PageRect(double X, double Y, double Width, double Height);

public sealed record ViewerObjectStyle
{
    /// <summary>Border color, as any CSS color.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Color { get; init; }

    /// <summary>Fill color, as any CSS color.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Fill { get; init; }

    /// <summary>
    /// Border width: <see cref="ViewerLength.PageUnits"/>, which scale with the zoom like the page, or any CSS
    /// length, such as <c>"2px"</c>, which stays the same on screen. The border is drawn inside the rectangle, so its
    /// outer edge is the rectangle's edge.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ViewerLength? BorderWidth { get; init; }

    /// <summary>
    /// How the border is drawn, solid by default. Unlike color, it survives high contrast modes, which replace every
    /// border's color with the same system color, so it can tell kinds of object apart there.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ViewerBorderStyle? BorderStyle { get; init; }
}

/// <summary>How an object's border is drawn.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ViewerBorderStyle>))]
public enum ViewerBorderStyle
{
    [JsonStringEnumMemberName("solid")] Solid,
    [JsonStringEnumMemberName("dashed")] Dashed,
    [JsonStringEnumMemberName("dotted")] Dotted,
    [JsonStringEnumMemberName("double")] Double,
}

/// <summary>
/// A length that is either a CSS length, such as <c>"2px"</c>, or a number of page units, in the coordinates objects
/// use, which scale with the zoom. A string converts to a CSS length, so <c>BorderWidth = "2px"</c> works.
/// </summary>
[JsonConverter(typeof(ViewerLengthJsonConverter))]
public readonly record struct ViewerLength
{
    private ViewerLength(string? cssLength, double? pageUnits)
    {
        CssLength = cssLength;
        PageUnitCount = pageUnits;
    }

    /// <summary>The CSS length, or null when the length is in page units.</summary>
    public string? CssLength { get; }

    /// <summary>The number of page units, or null when the length is a CSS length.</summary>
    public double? PageUnitCount { get; }

    /// <summary>A CSS length, such as <c>"2px"</c>, which stays the same on screen at any zoom.</summary>
    public static ViewerLength Css(string length) => new(length, null);

    /// <summary>A number of units in the coordinates objects use, which scales with the zoom like the page.</summary>
    public static ViewerLength PageUnits(double units) => new(null, units);

    public static implicit operator ViewerLength(string cssLength) => Css(cssLength);
}

/// <summary>
/// Writes a page-unit length as a number and a CSS length as a string, which is how the viewer reads them.
/// </summary>
internal sealed class ViewerLengthJsonConverter : JsonConverter<ViewerLength>
{
    public override ViewerLength Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Number
            ? ViewerLength.PageUnits(reader.GetDouble())
            : ViewerLength.Css(reader.GetString() ?? "");

    public override void Write(Utf8JsonWriter writer, ViewerLength value, JsonSerializerOptions options)
    {
        // A default ViewerLength is neither kind. It's written as null, which leaves the width unset, so the viewer's
        // default applies.
        if (value.PageUnitCount is { } units)
        {
            writer.WriteNumberValue(units);
        }
        else if (value.CssLength is { } length)
        {
            writer.WriteStringValue(length);
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}

/// <summary>What the draw tool gives each new object.</summary>
public sealed record ViewerDrawDefaults
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ViewerObjectStyle? Style { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Label { get; init; }

    /// <summary>The application's own category for the new object, which comes back on it in
    /// <see cref="PdfViewer.OnObjectDrawn"/> and <see cref="PdfViewer.OnObjectsChanged"/>.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Kind { get; init; }

    /// <summary>Classes from your own CSS, separated by spaces.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CssClass { get; init; }

    /// <summary>
    /// Your own values, shown as <c>data-app-*</c> attributes so tests can find objects by them. Keys start with a
    /// lowercase letter and contain only lowercase letters, digits and hyphens.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, string>? AppData { get; init; }
}

/// <summary>
/// An app-defined object on a page, displayed as a real DOM element with <c>data-object-id</c> set to its ID. A null
/// <paramref name="Page"/> shows it on whichever page is displayed, clipped where that page is smaller than its
/// rectangle.
/// </summary>
public sealed record ViewerObject(string Id, int? Page, PageRect Rect)
{
    /// <summary>A locked object can be selected, but not moved, resized or deleted by the user.</summary>
    public bool Locked { get; init; }

    /// <summary>An unselectable object is displayed, but ignores pointer and keyboard input.</summary>
    public bool Selectable { get; init; } = true;

    /// <summary>
    /// A hidden object is neither visible nor reachable by pointer or keyboard, and keeps its other state.
    /// </summary>
    public bool Hidden { get; init; }

    /// <summary>
    /// Whether the user can still select and edit the object while <see cref="PdfViewer.ReadOnly"/> is on. Set it on
    /// an object a dialog puts on the page for the user to adjust.
    /// </summary>
    public bool EditableWhenReadOnly { get; init; }

    /// <summary>
    /// The accessible name. Without one, it's "Object 3 on page 2" or similar, with a number unique on its page.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Label { get; init; }

    /// <summary>
    /// The application's own category for this object, such as "heading", shown as <c>data-object-kind</c>.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Kind { get; init; }

    /// <summary>
    /// Classes from your own CSS, separated by spaces, so you can style states such as emphasis in your stylesheet
    /// rather than with raw colors or widths.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CssClass { get; init; }

    /// <summary>
    /// Your own values, shown as <c>data-app-*</c> attributes so tests can find objects by them. Keys start with a
    /// lowercase letter and contain only lowercase letters, digits and hyphens.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, string>? AppData { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ViewerObjectStyle? Style { get; init; }

    /// <summary>
    /// Compares <see cref="AppData"/> by its entries rather than by reference, so objects with the same values are
    /// equal. The viewer sends an object again only when it differs from what it last sent.
    /// </summary>
    public bool Equals(ViewerObject? other) =>
        other is not null && Id == other.Id && Page == other.Page && Rect == other.Rect && Locked == other.Locked
        && Selectable == other.Selectable && Hidden == other.Hidden
        && EditableWhenReadOnly == other.EditableWhenReadOnly && Label == other.Label && Kind == other.Kind
        && CssClass == other.CssClass && Style == other.Style && SameEntries(AppData, other.AppData);

    public override int GetHashCode() => HashCode.Combine(Id, Page, Rect, Kind, Label);

    private static bool SameEntries(IReadOnlyDictionary<string, string>? first,
        IReadOnlyDictionary<string, string>? second) =>
        ReferenceEquals(first, second) || (first is not null && second is not null && first.Count == second.Count
            && first.All(entry => second.TryGetValue(entry.Key, out var value) && value == entry.Value));
}

[JsonConverter(typeof(JsonStringEnumConverter<ViewerTool>))]
public enum ViewerTool
{
    [JsonStringEnumMemberName("select")] Select,
    [JsonStringEnumMemberName("draw-rect")] DrawRectangle,
    [JsonStringEnumMemberName("none")] None,
}

[JsonConverter(typeof(JsonStringEnumConverter<ViewerZoomMode>))]
public enum ViewerZoomMode
{
    [JsonStringEnumMemberName("fit-width")] FitWidth,
    [JsonStringEnumMemberName("fit-page")] FitPage,
}

/// <summary>What object rectangles are measured against.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ViewerCoordinates>))]
public enum ViewerCoordinates
{
    /// <summary>The unrotated page, so a rectangle stays attached to the page's content at any rotation.</summary>
    [JsonStringEnumMemberName("page")] Page,

    /// <summary>
    /// The page as presented after rotation, including its UserUnit, so a rectangle keeps its numbers when a page rotates.
    /// </summary>
    [JsonStringEnumMemberName("display")] Display,
}

/// <summary>Where an object catches the pointer.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ViewerObjectHitArea>))]
public enum ViewerObjectHitArea
{
    /// <summary>The object's whole area.</summary>
    [JsonStringEnumMemberName("fill")] Fill,

    /// <summary>
    /// A band along its edges, so objects inside or behind it stay reachable. A selected or very small object still
    /// catches the pointer everywhere.
    /// </summary>
    [JsonStringEnumMemberName("border")] Border,
}

/// <summary>
/// A key held with an arrow key to move an object or take the large step. Shift isn't one, because it resizes.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<ViewerKeyModifier>))]
public enum ViewerKeyModifier
{
    [JsonStringEnumMemberName("ctrl")] Control,
    [JsonStringEnumMemberName("alt")] Alt,

    /// <summary>The Command key on a Mac, and the Windows key elsewhere.</summary>
    [JsonStringEnumMemberName("meta")] Meta,
}

/// <summary>
/// How the viewer behaves. Passing a different record takes effect at once, without ending a gesture in progress, and
/// the page repaints only when <see cref="HideFormFields"/> or <see cref="Coordinates"/> changes.
/// </summary>
public sealed record PdfViewerOptions
{
    /// <summary>
    /// The zoom each document opens at. A change takes effect at once while no document is open, and otherwise when
    /// the next one opens. With <see cref="KeepZoom"/> on, the zoom carries over from one document to the next
    /// instead, so only a change made while no document is open takes effect.
    /// </summary>
    public ViewerZoomMode InitialZoom { get; init; } = ViewerZoomMode.FitWidth;

    /// <summary>
    /// Whether a document that opens keeps the zoom the last one had, instead of opening at <see cref="InitialZoom"/>.
    /// </summary>
    public bool KeepZoom { get; init; }

    /// <summary>Leaves form fields unpainted, while other annotations still appear.</summary>
    public bool HideFormFields { get; init; }

    /// <summary>
    /// Whether keys edit objects: <see cref="KeyboardMoveModifier"/> with an arrow key moves the focused object and
    /// with Shift resizes it, Delete asks to delete it, and Escape clears the selection. Arrow keys, Home and End
    /// move focus between objects, and Space and Enter select, either way. Turn this off if your application handles
    /// the editing keys itself.
    /// </summary>
    public bool KeyboardEditing { get; init; } = true;

    /// <summary>
    /// How far <see cref="KeyboardMoveModifier"/> with an arrow key moves or resizes the focused object, in page units.
    /// A value that isn't a positive number is ignored.
    /// </summary>
    public double KeyboardStep { get; init; } = 1;

    /// <summary>
    /// How far an arrow key goes while <see cref="KeyboardLargeStepModifier"/> is held as well, in page units. A value
    /// that isn't a positive number is ignored.
    /// </summary>
    public double KeyboardLargeStep { get; init; } = 10;

    /// <summary>
    /// The key that, held with an arrow key, moves or resizes the object rather than moving focus. It has to differ
    /// from <see cref="KeyboardLargeStepModifier"/>; <see cref="PdfViewer"/> throws an
    /// <see cref="ArgumentException"/> if they're the same.
    /// </summary>
    public ViewerKeyModifier KeyboardMoveModifier { get; init; } = ViewerKeyModifier.Alt;

    /// <summary>
    /// The key that, held with <see cref="KeyboardMoveModifier"/> and an arrow key, takes the large step.
    /// </summary>
    public ViewerKeyModifier KeyboardLargeStepModifier { get; init; } = ViewerKeyModifier.Control;

    /// <summary>
    /// Whether an object is selected when it takes focus, by Tab or an arrow key. When off, moving focus through the
    /// objects changes nothing in your application: Space or Enter selects the focused object, and so does moving it
    /// with a key. Clicking selects either way.
    /// </summary>
    public bool SelectOnFocus { get; init; }

    /// <summary>Rounds rectangles the user creates or changes to whole page units.</summary>
    public bool RoundCoordinates { get; init; }

    /// <summary>
    /// Whether an object the user draws is selected once it's one of the viewer's objects. Leave it off if your
    /// application selects new objects itself.
    /// </summary>
    public bool SelectOnCreate { get; init; }

    /// <summary>Whether Ctrl+wheel and pinch gestures zoom.</summary>
    public bool WheelZoom { get; init; } = true;

    /// <summary>What object rectangles are measured against.</summary>
    public ViewerCoordinates Coordinates { get; init; } = ViewerCoordinates.Page;

    /// <summary>Where objects catch the pointer.</summary>
    public ViewerObjectHitArea ObjectHitArea { get; init; } = ViewerObjectHitArea.Fill;
}

/// <summary>Whether a change came from the person using the viewer or from the application's code.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ChangeOrigin>))]
public enum ChangeOrigin
{
    [JsonStringEnumMemberName("user")] User,
    [JsonStringEnumMemberName("api")] Api,
}

/// <summary>How the user changed an object's rectangle.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<EditGesture>))]
public enum EditGesture
{
    /// <summary>Dragging the object.</summary>
    [JsonStringEnumMemberName("move")] Move,

    /// <summary>Dragging a handle, or pressing Shift with an arrow key.</summary>
    [JsonStringEnumMemberName("resize")] Resize,

    /// <summary>
    /// Pressing an arrow key without Shift, or a call to <see cref="PdfViewerController.MoveObjectByAsync"/>.
    /// </summary>
    [JsonStringEnumMemberName("nudge")] Nudge,
}

/// <summary>A clockwise rotation in quarter turns.</summary>
public enum PageRotation
{
    None = 0,
    Clockwise90 = 90,
    Rotate180 = 180,
    Clockwise270 = 270,
}

/// <summary>
/// A page's label, and its size and total clockwise rotation in the coordinates objects use.
/// <paramref name="Label"/> is the page's label, such as "iv" or "A-3", or null if the document defines none.
/// </summary>
public sealed record PageInfo(int Page, string? Label, double Width, double Height, PageRotation Rotation);

/// <summary>
/// An object the user changed. <paramref name="Previous"/> is the object as it was before, and
/// <paramref name="Gesture"/> is set when the user changed its rectangle.
/// </summary>
public sealed record ObjectUpdate(ViewerObject Object, ViewerObject Previous, EditGesture? Gesture = null);

/// <summary>
/// What the user changed in one step: objects drawn, moved, resized or deleted. Removed objects are as they were.
/// Asynchronous handlers can finish out of order, so <paramref name="Sequence"/>, which counts every change to objects
/// and selection, tells which change is newest. Changes your own code makes aren't reported. A change the user makes
/// while one of yours is on its way to the browser wins over yours, so an update can arrive for an object you've just
/// removed from your list. Ignore it, and the next render removes the object again.
/// </summary>
public sealed record ObjectsChangedArgs(long Sequence, IReadOnlyList<ViewerObject> Added,
    IReadOnlyList<ObjectUpdate> Updated, IReadOnlyList<ViewerObject> Removed);

/// <summary>
/// The user finished drawing <paramref name="Object"/>, which has the draw tool's defaults. It's a draft, not yet one
/// of the viewer's objects. <paramref name="CancellationToken"/> is canceled if the draft is discarded while your
/// handler is still running, because its document closed or the viewer was disposed. Don't keep the object after
/// that, or it's added to whatever document is open by then.
/// </summary>
public sealed record ObjectDrawnArgs(ViewerObject Object, CancellationToken CancellationToken);

/// <summary>
/// The user pressed Delete on <paramref name="Object"/>, which is still one of the viewer's objects.
/// </summary>
public sealed record DeleteRequestedArgs(ViewerObject Object);

/// <summary>
/// The selection changed. <paramref name="PrimaryId"/> is the object selected last, or null when nothing is selected,
/// and <paramref name="Count"/> is how many are selected. The IDs themselves aren't sent, because any number of
/// objects can be selected. <see cref="PdfViewerController.GetSelectedObjectIdsAsync"/> returns the current
/// selection's IDs, which can be newer than this notification.
/// </summary>
public sealed record SelectionChangedArgs(long Sequence, ChangeOrigin Origin, string? PrimaryId, int Count);

public sealed record DocumentLoadedArgs(int PageCount);

public sealed record PageChangedArgs(int Page);

[JsonConverter(typeof(JsonStringEnumConverter<ViewerErrorCode>))]
public enum ViewerErrorCode
{
    /// <summary>The document couldn't open, for a reason the other codes don't cover.</summary>
    [JsonStringEnumMemberName("unknown")] Unknown,

    [JsonStringEnumMemberName("invalid-pdf")] InvalidPdf,

    /// <summary>
    /// The document couldn't be fetched. For a URL source, this also covers any other error from pdf.js, because it
    /// reports a refused connection as a generic error.
    /// </summary>
    [JsonStringEnumMemberName("network")] Network,

    [JsonStringEnumMemberName("password-required")] PasswordRequired,

    [JsonStringEnumMemberName("password-incorrect")] PasswordIncorrect,

    /// <summary>A page couldn't be loaded. The document stays open.</summary>
    [JsonStringEnumMemberName("page")] Page,

    /// <summary>A page couldn't be painted. The document stays open.</summary>
    [JsonStringEnumMemberName("render")] Render,

    /// <summary>A command was rejected. The document stays open.</summary>
    [JsonStringEnumMemberName("command")] Command,
}

/// <summary>
/// A viewer failure. <paramref name="DocumentClosed"/> tells whether the document failed to open and is now closed.
/// </summary>
public sealed record ViewerError(ViewerErrorCode Code, string Message,
    [property: JsonPropertyName("documentFailed")] bool DocumentClosed);
