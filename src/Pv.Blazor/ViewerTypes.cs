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

[JsonConverter(typeof(JsonStringEnumConverter<ObjectChangeKind>))]
public enum ObjectChangeKind
{
    [JsonStringEnumMemberName("added")] Added,
    [JsonStringEnumMemberName("updated")] Updated,
    [JsonStringEnumMemberName("removed")] Removed,
    [JsonStringEnumMemberName("replaced")] Replaced,
}

/// <summary>
/// A change to the viewer's objects. Asynchronous handlers can finish out of order, so <paramref name="Sequence"/>
/// tells which change is newest. <paramref name="Object"/> is null when <paramref name="Kind"/> is
/// <see cref="ObjectChangeKind.Replaced"/>.
/// </summary>
public sealed record ViewerObjectChange(long Sequence, ChangeOrigin Origin, ObjectChangeKind Kind,
    ViewerObject? Object);

public sealed record ViewerSelectionChange(long Sequence, ChangeOrigin Origin, string? Id);

public sealed record DocumentLoadedArgs(int PageCount);

/// <summary>
/// A viewer failure. <paramref name="Code"/> is a stable value: <c>invalid-pdf</c>, <c>network</c>,
/// <c>password-required</c>, <c>password-incorrect</c> or <c>unknown</c> when a document couldn't open, <c>page</c> or
/// <c>render</c> when a page failed, and <c>command</c> when a command was rejected. For a URL source, <c>network</c>
/// also covers any other error from pdf.js, because it reports a refused connection as a generic error.
/// </summary>
public sealed record ViewerError(string Code, string Message);
