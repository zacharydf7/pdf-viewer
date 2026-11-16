using Microsoft.Playwright;

namespace Pv.Testing.Playwright;

/// <summary>Playwright locator helpers for pages that contain a PDF viewer.</summary>
public static class LocatorExtensions
{
    /// <summary>
    /// Leaves out matches inside any PDF viewer. A viewer puts the document's text in the DOM as its text layer, so
    /// <c>GetByText</c> can otherwise find the PDF's words instead of the application's.
    /// </summary>
    public static ILocator OutsideViewers(this ILocator locator) =>
        locator.Locator("xpath=self::*[not(ancestor-or-self::pdf-viewer)]");
}
