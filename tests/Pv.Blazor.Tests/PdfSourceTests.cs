using Microsoft.AspNetCore.Components;

namespace Pv.Blazor.Tests;

public class PdfSourceTests
{
    [Fact]
    public void Equals_ShouldBeTrue_WhenUrlSourcesMatch()
    {
        var headers = new Dictionary<string, string> { ["X-Key"] = "1" };
        var sameHeaders = new Dictionary<string, string> { ["X-Key"] = "1" };

        Assert.Equal(PdfSource.FromUrl("/a.pdf", headers), PdfSource.FromUrl("/a.pdf", sameHeaders));
    }

    [Fact]
    public void Equals_ShouldBeFalse_WhenUrlsDiffer() =>
        Assert.NotEqual(PdfSource.FromUrl("/a.pdf"), PdfSource.FromUrl("/b.pdf"));

    [Fact]
    public void Equals_ShouldBeFalse_WhenHeadersDiffer()
    {
        var first = PdfSource.FromUrl("/a.pdf", new Dictionary<string, string> { ["X-Key"] = "1" });
        var second = PdfSource.FromUrl("/a.pdf", new Dictionary<string, string> { ["X-Key"] = "2" });

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void Equals_ShouldBeFalse_WhenCredentialsDiffer() =>
        Assert.NotEqual(PdfSource.FromUrl("/a.pdf"), PdfSource.FromUrl("/a.pdf", withCredentials: true));

    [Fact]
    public void Equals_ShouldBeFalse_WhenFileInputSourcesComeFromSeparateSelections()
    {
        var input = new ElementReference("input");

        Assert.NotEqual(PdfSource.FromFileInput(input), PdfSource.FromFileInput(input));
    }

    [Fact]
    public void Equals_ShouldBeTrue_WhenComparingFileInputSourceToItself()
    {
        var source = PdfSource.FromFileInput(new ElementReference("input"));

        Assert.True(source.Equals(source));
    }

    [Fact]
    public void Equals_ShouldBeFalse_WhenComparingUrlToFileInput() =>
        Assert.False(PdfSource.FromUrl("/a.pdf").Equals(PdfSource.FromFileInput(new ElementReference("input"))));

    [Fact]
    public void ImplicitConversion_ShouldCreateUrlSource_WhenGivenString()
    {
        PdfSource source = "/a.pdf";

        Assert.Equal(PdfSource.FromUrl("/a.pdf"), source);
    }

    [Fact]
    public void FromUrl_ShouldThrow_WhenGivenEmptyUrl() =>
        Assert.Throws<ArgumentException>(() => PdfSource.FromUrl(""));
}
