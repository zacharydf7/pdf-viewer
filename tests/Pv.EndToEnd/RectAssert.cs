using Pv.Blazor;

namespace Pv.EndToEnd;

internal static class RectAssert
{
    /// <summary>Checks each edge, since a gesture with the real mouse lands within about a unit of where it aimed.</summary>
    public static void Near(PageRect expected, PageRect actual, double tolerance = 1)
    {
        double[] expectedEdges = [expected.X, expected.Y, expected.X + expected.Width, expected.Y + expected.Height];
        double[] actualEdges = [actual.X, actual.Y, actual.X + actual.Width, actual.Y + actual.Height];
        for (var edge = 0; edge < 4; edge++)
        {
            Assert.True(Math.Abs(expectedEdges[edge] - actualEdges[edge]) <= tolerance,
                $"Expected {actual} to be within {tolerance} of {expected} on every edge.");
        }
    }
}
