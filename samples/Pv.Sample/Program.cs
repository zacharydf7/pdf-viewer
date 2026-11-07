using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Pv.Sample.Components;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(options =>
{
    options.Events.OnRedirectToLogin = context =>
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    };
});
builder.Services.AddAuthorization();

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();
app.UseAntiforgery();
app.MapStaticAssets();

var documentsDirectory = Path.Combine(AppContext.BaseDirectory, "documents");

IResult ServeDocument(string name)
{
    var path = Path.Combine(documentsDirectory, Path.GetFileName(name));
    return File.Exists(path) ? Results.File(path, "application/pdf", enableRangeProcessing: true) : Results.NotFound();
}

app.MapGet("/documents/{name}", ServeDocument);

// Shows that the browser's own requests carry the user's cookie, so authorization works as it does on any endpoint.
app.MapGet("/secure-documents/{name}", ServeDocument).RequireAuthorization();
app.MapGet("/demo-sign-in", async (HttpContext context) =>
{
    var claims = new[] { new Claim(ClaimTypes.Name, "demo") };
    var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
    await context.SignInAsync(new ClaimsPrincipal(identity));
    return Results.Redirect("/");
});

app.MapRazorComponents<App>().AddInteractiveServerRenderMode();

app.Run();
