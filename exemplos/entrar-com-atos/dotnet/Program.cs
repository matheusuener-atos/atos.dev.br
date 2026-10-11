// Entrar com Atos num servidor ASP.NET Core com o Microsoft.AspNetCore.Authentication.OpenIdConnect: cliente
// confidencial, PKCE S256. O handler le a descoberta, gera state, nonce e code_verifier, troca o codigo e confere o
// id_token (ES256 pela JWKS, iss, aud, exp, nonce); depois le o userinfo.
//
//   dotnet add package Microsoft.AspNetCore.Authentication.OpenIdConnect
//   ATOS_CLIENT_ID=... ATOS_CLIENT_SECRET=... ATOS_REDIRECT_URI=https://seusistema.com.br/signin-oidc dotnet run
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

static string Env(string nome) => Environment.GetEnvironmentVariable(nome) ?? throw new InvalidOperationException("Falta a variável " + nome);

var issuer = Environment.GetEnvironmentVariable("ATOS_ISSUER") ?? "https://atos.dev.br";
var volta = new Uri(Env("ATOS_REDIRECT_URI"));

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(o =>
{
    o.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    o.DefaultChallengeScheme = "Atos";
})
.AddCookie()
.AddOpenIdConnect("Atos", o =>
{
    o.Authority = issuer;
    o.ClientId = Env("ATOS_CLIENT_ID");
    o.ClientSecret = Env("ATOS_CLIENT_SECRET"); // só no servidor, nunca no repositório
    o.ResponseType = OpenIdConnectResponseType.Code;
    o.ResponseMode = OpenIdConnectResponseMode.Query; // a Atos volta na consulta (o padrão do handler é form_post)
    o.UsePkce = true;
    o.CallbackPath = volta.AbsolutePath;
    o.Scope.Clear();
    o.Scope.Add("openid");
    o.Scope.Add("email");
    o.Scope.Add("profile");
    o.GetClaimsFromUserInfoEndpoint = true;
    o.MapInboundClaims = false; // os nomes do OpenID Connect (sub, name, email)
    o.TokenValidationParameters.NameClaimType = "name";
    o.AccessDeniedPath = "/sem-acesso"; // error=access_denied: a conta não tem acesso ou a pessoa não permitiu
    o.RequireHttpsMetadata = issuer.StartsWith("https://"); // http só no teste local
});
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/", (HttpContext c) => c.User.Identity?.IsAuthenticated == true
    ? Results.Text($"Olá, {c.User.FindFirst("name")?.Value} ({c.User.FindFirst("email")?.Value}). id: {c.User.FindFirst("sub")?.Value}")
    : Results.Text("Entre em /entrar"));
app.MapGet("/entrar", () => Results.Challenge(new AuthenticationProperties { RedirectUri = "/" }, ["Atos"]));
app.MapGet("/sem-acesso", () => Results.Text("Sua Conta Atos não tem acesso a este sistema (ou o acesso não foi permitido). Peça a quem administra.", statusCode: 403));
app.MapGet("/sair", async (HttpContext c) => { await c.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme); return Results.Redirect("/"); });

app.Run();
