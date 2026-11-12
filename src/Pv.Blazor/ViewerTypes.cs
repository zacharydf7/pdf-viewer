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

    /// <summary>Border width, as any CSS length.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? BorderWidth { get; init; }
}

/// <summary>What the draw tool gives each new object.</summary>
public sealed record ViewerDrawDefaults
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ViewerObjectStyle? Style { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Label { get; init; }

    /// <summary>The application's own category for the new object, which comes back on its change event.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Tag { get; init; }
}

/// <summary>
/// An app-defined object on a page, displayed as a real DOM element with <c>data-object-id</c> set to its ID.
/// </summary>
public sealed record ViewerObject(string Id, int Page, PageRect Rect)
{
    /// <summary>A locked object can be selected, but not moved, resized or deleted by the user.</summary>
    public bool Locked { get; init; }

    /// <summary>An unselectable object is displayed, but ignores pointer and keyboard input.</summary>
    public bool Selectable { get; init; } = true;

    /// <summary>The accessible name.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Label { get; init; }

    /// <summary>The application's own category for this object, shown as <c>data-object-tag</c>.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Tag { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ViewerObjectStyle? Style { get; init; }
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

    /// <summary>Pressing an arrow key without Shift.</summary>
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
/// An object was added. Asynchronous handlers can finish out of order, so <paramref name="Sequence"/>, which counts
/// every change to objects and selection, tells which change is newest.
/// </summary>
public sealed record ObjectAddedArgs(long Sequence, ChangeOrigin Origin, ViewerObject Object);

/// <summary>
/// An object changed. <paramref name="Previous"/> is the object as it was before, and <paramref name="Gesture"/> is
/// set when the user changed its rectangle.
/// </summary>
public sealed record ObjectUpdatedArgs(long Sequence, ChangeOrigin Origin, ViewerObject Object, ViewerObject Previous,
    EditGesture? Gesture = null);

/// <summary>An object was removed. <paramref name="Object"/> is the object as it was.</summary>
public sealed record ObjectRemovedArgs(long Sequence, ChangeOrigin Origin, ViewerObject Object);

/// <summary>Every object was replaced in one step.</summary>
public sealed record ObjectsReplacedArgs(long Sequence, ChangeOrigin Origin);

/// <summary>
/// The selection changed. <paramref name="PrimaryId"/> is the object selected last, or null when nothing is selected,
/// and <paramref name="Count"/> is how many are selected. The IDs themselves aren't sent, because any number of
/// objects can be selected. <see cref="PdfViewer.GetSelectedObjectIdsAsync"/> returns the current selection's IDs,
/// which can be newer than this notification.
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
