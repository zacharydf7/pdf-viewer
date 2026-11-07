using Microsoft.AspNetCore.Components;

namespace Pv.Blazor;

/// <summary>
/// Where a document comes from. PDF bytes never cross the Blazor circuit: the browser fetches a URL itself, using range
/// requests when the server supports them, and reads a local file itself.
/// </summary>
public sealed class PdfSource : IEquatable<PdfSource>
{
    private readonly string? _url;
    private readonly IReadOnlyDictionary<string, string>? _headers;
    private readonly bool _withCredentials;
    private readonly ElementReference? _fileInput;
    private readonly Guid _fileSelection;

    private PdfSource(string url, IReadOnlyDictionary<string, string>? headers, bool withCredentials)
    {
        _url = url;
        _headers = headers;
        _withCredentials = withCredentials;
    }

    private PdfSource(ElementReference fileInput)
    {
        _fileInput = fileInput;
        _fileSelection = Guid.NewGuid();
    }

    /// <summary>A URL the browser fetches, with optional request headers and cross-origin credentials.</summary>
    public static PdfSource FromUrl(string url, IReadOnlyDictionary<string, string>? headers = null,
        bool withCredentials = false)
    {
        ArgumentException.ThrowIfNullOrEmpty(url);
        return new PdfSource(url, headers, withCredentials);
    }

    /// <summary>
    /// The file currently selected in an <c>&lt;input type="file"&gt;</c>. Each call counts as a new source, so create
    /// one when the selection changes rather than during rendering.
    /// </summary>
    public static PdfSource FromFileInput(ElementReference fileInput) => new(fileInput);

    public static implicit operator PdfSource(string url) => FromUrl(url);

    public bool Equals(PdfSource? other)
    {
        if (other is null)
        {
            return false;
        }
        if (_fileInput is not null || other._fileInput is not null)
        {
            return _fileSelection == other._fileSelection;
        }
        return _url == other._url && _withCredentials == other._withCredentials
            && HeadersEqual(_headers, other._headers);
    }

    public override bool Equals(object? obj) => Equals(obj as PdfSource);

    public override int GetHashCode() =>
        _fileInput is null ? HashCode.Combine(_url, _withCredentials) : _fileSelection.GetHashCode();

    /// <summary>The shape the viewer's JavaScript expects.</summary>
    internal object ToInterop() => _fileInput is { } input
        ? new { kind = "file-input", input }
        : new { kind = "url", url = _url, headers = _headers, withCredentials = _withCredentials };

    private static bool HeadersEqual(IReadOnlyDictionary<string, string>? left,
        IReadOnlyDictionary<string, string>? right)
    {
        if (left is null || right is null)
        {
            return ReferenceEquals(left, right);
        }
        return left.Count == right.Count
            && left.All(pair => right.TryGetValue(pair.Key, out var value) && value == pair.Value);
    }
}
