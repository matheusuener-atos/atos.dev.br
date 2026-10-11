/* O "Entrar com Atos" em cada linguagem: a biblioteca, a instalacao e o trecho minimo, e os comandos que gravam o .env
   (PowerShell e Linux/macOS). Usado pelo cartao "Como integrar" (integrar.js; com os dados do acesso) e pela pagina
   /integracao/ (com marcadores; a pagina e gerada por tools/integracao-linguagens.mjs a partir daqui).

   Os trechos de Python e C#/.NET sao os arquivos de exemplos/entrar-com-atos/, testados contra a Atos por
   exemplos/entrar-com-atos/testar.mjs (worker/teste-linguagens.mjs confere que sao iguais). O de JavaScript usa o
   pacote @atos.dev.br/entrar (pacotes/entrar, testado; o servidor tambem roda no testar.mjs). PHP, Java, Go e Ruby foram
   escritos pela documentacao de cada biblioteca e nao foram testados aqui: a tela diz isso.

     IntegrarLinguagens.lista(v)          -> [{id, nome, biblioteca, testado, nota, instalar, codigo | codigos}]
       v: {clientId, volta, confidencial, ambos?} (ambos: o navegador e o servidor Node; a pagina)  (os servidores leem o resto do .env: ATOS_ISSUER, ATOS_CLIENT_ID,
                                            ATOS_CLIENT_SECRET, ATOS_REDIRECT_URI)
     IntegrarLinguagens.comandoEnv(v, "ps"|"sh")  v: {emissor, clientId, volta, confidencial} -> o comando
     IntegrarLinguagens.PACOTE            o endereco do entrar.js servido pela Atos

   Sem estado e sem DOM: roda tambem no Node (os testes). */
(function (raiz) {
  "use strict";
  if (raiz.IntegrarLinguagens) return;

  var PACOTE = "https://atos.dev.br/pacotes/entrar/0.2.0/entrar.js";
  var jsTexto = function (s) { return JSON.stringify(String(s)); };

  // ------------------------------------------------------------------ JavaScript (o pacote @atos.dev.br/entrar)

  function jsNavegador(v) {
    return [
      "// Navegador (cliente público, sem segredo). Com empacotador (Vite, webpack...): o pacote do npm.",
      '// Sem empacotador: baixe o entrar.js (o mesmo código) e importe de "./entrar.js".',
      'import { entrarComAtos } from "@atos.dev.br/entrar";',
      "",
      "const atos = entrarComAtos({",
      "  clientId: " + jsTexto(v.clientId) + ",",
      "  voltaPara: " + jsTexto(v.volta) + ", // exatamente como cadastrada",
      "});",
      "",
      "// O botão: gera state, nonce e code_verifier, guarda em sessionStorage e vai à Atos.",
      'document.querySelector("#entrar-com-atos").addEventListener("click", () => atos.entrar());',
      "",
      "// Na página de volta: confere state e iss, troca o código e confere o id_token (ES256 pela JWKS).",
      "try {",
      "  const pessoa = await atos.retorno(); // null quando a página não é uma volta",
      "  if (pessoa) console.log(pessoa.id, pessoa.nome, pessoa.email); // identifique pelo id (o sub)",
      "} catch (e) {",
      '  if (e.codigo === "access_denied") alert(e.message); // a conta não tem acesso ou não permitiu',
      "  else throw e;",
      "}",
    ].join("\n");
  }

  var JS_SERVIDOR = String.raw`// Servidor Node com Express (cliente confidencial), com o pacote @atos.dev.br/entrar.
// O segredo fica só em ATOS_CLIENT_SECRET (o pacote lê de lá). Rode com: node --env-file=.env servidor.mjs
import express from "express";
import session from "express-session";
import { entrarComAtos } from "@atos.dev.br/entrar";

const atos = entrarComAtos({
  clientId: process.env.ATOS_CLIENT_ID,
  voltaPara: process.env.ATOS_REDIRECT_URI,
  emissor: process.env.ATOS_ISSUER, // vazio: https://atos.dev.br
});
const app = express();
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: "lax" } }));

app.get("/", (req, res) => {
  const p = req.session.pessoa;
  res.type("text").send(p ? "Olá, " + p.nome + " (" + p.email + "). id: " + p.id : "Entre em /entrar");
});

app.get("/entrar", async (req, res) => {
  const { url, guardar } = await atos.comecar(); // state, nonce e code_verifier
  req.session.atos = guardar;
  res.redirect(url);
});

app.get(new URL(atos.voltaPara).pathname, async (req, res) => {
  const guardado = req.session.atos;
  delete req.session.atos;
  try {
    const pessoa = await atos.concluir(req.originalUrl, guardado); // confere tudo e troca o código
    req.session.pessoa = { id: pessoa.id, nome: pessoa.nome, email: pessoa.email };
    res.redirect("/");
  } catch (e) {
    // access_denied: a conta não tem acesso ou a pessoa não permitiu
    res.status(e.codigo === "access_denied" ? 403 : 400).type("text").send(e.message);
  }
});

app.listen(Number(new URL(atos.voltaPara).port) || 3000);
`;

  // ------------------------------------------------------------------ Python (Authlib + Flask), testado

  var PYTHON = String.raw`# Entrar com Atos num servidor Python (Flask) com o Authlib: cliente confidencial, PKCE S256.
# O Authlib le a descoberta, gera state, nonce e code_verifier, troca o codigo (client_secret_basic) e confere o
# id_token (ES256 pela JWKS, iss, aud, exp, nonce).
#
#   pip install authlib flask requests
#   ATOS_CLIENT_ID=... ATOS_CLIENT_SECRET=... ATOS_REDIRECT_URI=http://127.0.0.1:5000/retorno FLASK_SECRET_KEY=... python app.py
import os
from urllib.parse import urlsplit

from authlib.integrations.flask_client import OAuth, OAuthError
from flask import Flask, redirect, session
from markupsafe import escape

ISSUER = os.environ.get("ATOS_ISSUER", "https://atos.dev.br")
VOLTA = os.environ["ATOS_REDIRECT_URI"]

app = Flask(__name__)
app.secret_key = os.environ["FLASK_SECRET_KEY"]  # assina o cookie da sessao do Flask
oauth = OAuth(app)
oauth.register(
    "atos",
    server_metadata_url=ISSUER + "/.well-known/openid-configuration",
    client_id=os.environ["ATOS_CLIENT_ID"],
    client_secret=os.environ["ATOS_CLIENT_SECRET"],  # so no servidor, nunca no repositorio
    client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
)


@app.route("/")
def inicio():
    p = session.get("pessoa")
    if not p:
        return '<a href="/entrar">Entrar com Atos</a>'
    return f"Olá, {escape(p['nome'])} ({escape(p['email'])}). id: {escape(p['id'])}. <a href=\"/sair\">Sair</a>"


@app.route("/entrar")
def entrar():
    return oauth.atos.authorize_redirect(VOLTA)


@app.route(urlsplit(VOLTA).path)
def retorno():
    try:
        token = oauth.atos.authorize_access_token()  # confere state, troca o codigo e confere o id_token
    except OAuthError as e:
        if e.error == "access_denied":
            return "Sua Conta Atos não tem acesso a este sistema (ou o acesso não foi permitido). Peça a quem administra.", 403
        return "Não deu para entrar: " + escape(e.error), 400
    claims = token["userinfo"]  # o corpo do id_token, ja conferido
    # Opcional: pergunta a Atos (userinfo) se o acesso ainda vale.
    dados = oauth.atos.userinfo(token=token)
    if dados["sub"] != claims["sub"]:
        return "Resposta inconsistente da Atos.", 400
    session["pessoa"] = {"id": claims["sub"], "nome": claims.get("name", ""), "email": claims.get("email", "")}
    return redirect("/")


@app.route("/sair")
def sair():
    session.clear()
    return redirect("/")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=urlsplit(VOLTA).port or 5000)
`;

  // ------------------------------------------------------------------ C#/.NET (OpenIdConnect), testado

  var DOTNET = String.raw`// Entrar com Atos num servidor ASP.NET Core com o Microsoft.AspNetCore.Authentication.OpenIdConnect: cliente
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
`;

  // ------------------------------------------------------------------ PHP (league/oauth2-client + firebase/php-jwt), nao testado

  var PHP = String.raw`<?php
// Entrar com Atos em PHP: league/oauth2-client (PKCE S256) e firebase/php-jwt (o id_token ES256 pela JWKS).
// Este arquivo é a ida e a volta: ATOS_REDIRECT_URI aponta para ele (ex.: https://seusistema.com.br/entrar.php).
// Não testado aqui: escrito pela documentação das duas bibliotecas.
require __DIR__ . '/vendor/autoload.php';

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use League\OAuth2\Client\Provider\GenericProvider;

session_start();
$issuer = getenv('ATOS_ISSUER') ?: 'https://atos.dev.br';
$clientId = getenv('ATOS_CLIENT_ID');
$d = json_decode(file_get_contents($issuer . '/.well-known/openid-configuration'), true);
if (($d['issuer'] ?? '') !== $issuer) { http_response_code(502); exit('A descoberta não é da Atos.'); }

$atos = new GenericProvider([
    'clientId' => $clientId,
    'clientSecret' => getenv('ATOS_CLIENT_SECRET'), // só no servidor, nunca no repositório
    'redirectUri' => getenv('ATOS_REDIRECT_URI'),
    'urlAuthorize' => $d['authorization_endpoint'],
    'urlAccessToken' => $d['token_endpoint'],
    'urlResourceOwnerDetails' => $d['userinfo_endpoint'],
    'scopes' => ['openid', 'email', 'profile'],
    'scopeSeparator' => ' ',
    'pkceMethod' => GenericProvider::PKCE_METHOD_S256,
]);

if (!isset($_GET['code']) && !isset($_GET['error'])) {
    // A ida: state, nonce e code_verifier ficam na sessão.
    $nonce = bin2hex(random_bytes(16));
    $url = $atos->getAuthorizationUrl(['nonce' => $nonce]);
    $_SESSION['atos'] = ['state' => $atos->getState(), 'pkce' => $atos->getPkceCode(), 'nonce' => $nonce];
    header('Location: ' . $url);
    exit;
}

// A volta.
$ida = $_SESSION['atos'] ?? null;
unset($_SESSION['atos']);
if (!$ida || !hash_equals($ida['state'], $_GET['state'] ?? '')) { http_response_code(400); exit('O state não confere.'); }
if (($_GET['error'] ?? '') === 'access_denied') {
    http_response_code(403);
    exit('Sua Conta Atos não tem acesso a este sistema (ou o acesso não foi permitido). Peça a quem administra.');
}
$atos->setPkceCode($ida['pkce']);
$token = $atos->getAccessToken('authorization_code', ['code' => $_GET['code']]);

JWT::$leeway = 60;
$jwks = json_decode(file_get_contents($d['jwks_uri']), true);
$c = JWT::decode($token->getValues()['id_token'], JWK::parseKeySet($jwks)); // assinatura pelo kid e exp
if ($c->iss !== $issuer || $c->aud !== $clientId || !hash_equals($ida['nonce'], $c->nonce ?? '')) {
    http_response_code(400);
    exit('O id_token não confere.');
}
session_regenerate_id(true);
$_SESSION['pessoa'] = ['id' => $c->sub, 'nome' => $c->name ?? '', 'email' => $c->email ?? ''];
header('Location: /');
`;

  // ------------------------------------------------------------------ Java (Spring Security OAuth2 Client), nao testado

  var JAVA = String.raw`// Entrar com Atos em Spring Boot 3 com o Spring Security OAuth2 Client: cliente confidencial, PKCE S256.
// Não testado aqui: escrito pela documentação do Spring Security.
//
// application.yml (a volta é https://seusistema.com.br/login/oauth2/code/atos):
//
//   spring.security.oauth2.client:
//     provider.atos:
//       issuer-uri: \${ATOS_ISSUER:https://atos.dev.br}
//       user-name-attribute: sub
//     registration.atos:
//       client-id: \${ATOS_CLIENT_ID}
//       client-secret: \${ATOS_CLIENT_SECRET}
//       client-authentication-method: client_secret_basic
//       authorization-grant-type: authorization_code
//       redirect-uri: "{baseUrl}/login/oauth2/code/{registrationId}"
//       scope: openid,email,profile
package br.com.seusistema;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.client.oidc.authentication.OidcIdTokenDecoderFactory;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoderFactory;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@Configuration
class SegurancaAtos {
    @Bean
    SecurityFilterChain seguranca(HttpSecurity http, ClientRegistrationRepository clientes) throws Exception {
        var resolver = new DefaultOAuth2AuthorizationRequestResolver(clientes, "/oauth2/authorization");
        resolver.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce()); // PKCE S256 também no confidencial
        http.authorizeHttpRequests(a -> a.requestMatchers("/sem-acesso").permitAll().anyRequest().authenticated())
            .oauth2Login(o -> o.authorizationEndpoint(e -> e.authorizationRequestResolver(resolver))
                .failureUrl("/sem-acesso")); // error=access_denied cai aqui
        return http.build();
    }

    // A Atos assina o id_token em ES256 (o padrão do Spring é RS256).
    @Bean
    JwtDecoderFactory<ClientRegistration> idTokenDecoderFactory() {
        var f = new OidcIdTokenDecoderFactory();
        f.setJwsAlgorithmResolver(c -> SignatureAlgorithm.ES256);
        return f;
    }
}

@RestController
class Inicio {
    @GetMapping("/")
    String inicio(@AuthenticationPrincipal OidcUser p) {
        return "Olá, " + p.getFullName() + " (" + p.getEmail() + "). id: " + p.getSubject();
    }

    @GetMapping("/sem-acesso")
    String semAcesso() {
        return "Sua Conta Atos não tem acesso a este sistema (ou o acesso não foi permitido). Peça a quem administra.";
    }
}
`.replace(/\\\$\{/g, "${");

  // ------------------------------------------------------------------ Go (go-oidc + x/oauth2), nao testado

  var GO = String.raw`// Entrar com Atos em Go com github.com/coreos/go-oidc/v3 e golang.org/x/oauth2: cliente confidencial, PKCE S256.
// Não testado aqui: escrito pela documentação das duas bibliotecas.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

func aleatorio() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func main() {
	issuer := os.Getenv("ATOS_ISSUER")
	if issuer == "" {
		issuer = "https://atos.dev.br"
	}
	provider, err := oidc.NewProvider(context.Background(), issuer) // lê a descoberta e confere o issuer
	if err != nil {
		log.Fatal(err)
	}
	conf := oauth2.Config{
		ClientID:     os.Getenv("ATOS_CLIENT_ID"),
		ClientSecret: os.Getenv("ATOS_CLIENT_SECRET"), // só no servidor, nunca no repositório
		RedirectURL:  os.Getenv("ATOS_REDIRECT_URI"),
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}
	verificador := provider.Verifier(&oidc.Config{ClientID: conf.ClientID}) // ES256 pela JWKS, iss, aud, exp
	volta, err := url.Parse(conf.RedirectURL)
	if err != nil {
		log.Fatal(err)
	}
	guardar := func(w http.ResponseWriter, nome, valor string) {
		http.SetCookie(w, &http.Cookie{Name: nome, Value: valor, Path: "/", MaxAge: 600, HttpOnly: true,
			Secure: volta.Scheme == "https", SameSite: http.SameSiteLaxMode})
	}

	http.HandleFunc("/entrar", func(w http.ResponseWriter, r *http.Request) {
		state, nonce, verifier := aleatorio(), aleatorio(), oauth2.GenerateVerifier()
		guardar(w, "atos_state", state)
		guardar(w, "atos_nonce", nonce)
		guardar(w, "atos_verifier", verifier)
		http.Redirect(w, r, conf.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
	})

	http.HandleFunc(volta.Path, func(w http.ResponseWriter, r *http.Request) {
		lido := func(nome string) string {
			c, err := r.Cookie(nome)
			if err != nil {
				return ""
			}
			return c.Value
		}
		q := r.URL.Query()
		if lido("atos_state") == "" || q.Get("state") != lido("atos_state") {
			http.Error(w, "O state não confere.", http.StatusBadRequest)
			return
		}
		if q.Get("error") == "access_denied" {
			http.Error(w, "Sua Conta Atos não tem acesso a este sistema (ou o acesso não foi permitido). Peça a quem administra.", http.StatusForbidden)
			return
		}
		tok, err := conf.Exchange(r.Context(), q.Get("code"), oauth2.VerifierOption(lido("atos_verifier")))
		if err != nil {
			http.Error(w, "A Atos recusou a troca do código.", http.StatusBadRequest)
			return
		}
		bruto, _ := tok.Extra("id_token").(string)
		idt, err := verificador.Verify(r.Context(), bruto)
		if err != nil || idt.Nonce != lido("atos_nonce") {
			http.Error(w, "O id_token não confere.", http.StatusBadRequest)
			return
		}
		var c struct{ Name, Email string }
		if err := idt.Claims(&c); err != nil {
			http.Error(w, "id_token ilegível.", http.StatusBadRequest)
			return
		}
		// Crie aqui a sua sessão, identificando a pessoa por idt.Subject (o sub).
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "Olá, %s (%s). id: %s", c.Name, c.Email, idt.Subject)
	})

	porta := os.Getenv("PORT")
	if porta == "" {
		porta = "8080"
	}
	log.Fatal(http.ListenAndServe(":"+porta, nil))
}
`;

  // ------------------------------------------------------------------ Ruby (omniauth_openid_connect, Rails), nao testado

  var RUBY = String.raw`# Entrar com Atos em Rails com o omniauth_openid_connect: cliente confidencial, PKCE S256.
# Não testado aqui: escrito pela documentação da gem. A volta é https://seusistema.com.br/auth/atos/callback.

# config/initializers/omniauth.rb
Rails.application.config.middleware.use OmniAuth::Builder do
  provider :openid_connect,
    name: :atos,
    issuer: ENV.fetch("ATOS_ISSUER", "https://atos.dev.br"),
    discovery: true, # lê a descoberta e a JWKS; confere o id_token (ES256, iss, aud, exp, nonce)
    scope: [:openid, :email, :profile],
    response_type: :code,
    pkce: true,
    client_auth_method: :basic,
    client_options: {
      identifier: ENV.fetch("ATOS_CLIENT_ID"),
      secret: ENV.fetch("ATOS_CLIENT_SECRET"), # só no servidor, nunca no repositório
      redirect_uri: ENV.fetch("ATOS_REDIRECT_URI"),
    }
end
OmniAuth.config.on_failure = proc { |env| OmniAuth::FailureEndpoint.new(env).redirect_to_failure }

# config/routes.rb
#   get "/auth/atos/callback", to: "sessoes#criar"
#   get "/auth/failure", to: "sessoes#falha"

# app/controllers/sessoes_controller.rb
class SessoesController < ApplicationController
  def criar
    auth = request.env["omniauth.auth"]
    reset_session
    session[:pessoa] = { id: auth.uid, nome: auth.info.name, email: auth.info.email } # uid é o sub
    redirect_to root_path
  end

  def falha
    if params[:message] == "access_denied"
      render plain: "Sua Conta Atos não tem acesso a este sistema (ou o acesso não foi permitido). Peça a quem administra.", status: :forbidden
    else
      render plain: "Não deu para entrar.", status: :bad_request
    end
  end
end

# O botão (POST, com o token CSRF; gem omniauth-rails_csrf_protection):
#   <%= button_to "Entrar com Atos", "/auth/atos", data: { turbo: false } %>
`;

  function lista(v) {
    v = v || {};
    return [
      {
        id: "js", nome: "JavaScript", biblioteca: "@atos.dev.br/entrar (o pacote da Atos, sem dependências)", testado: true,
        nota: "Testado contra a Atos: o pacote no Node e num navegador simulado (state, iss, access_denied e id_token forjados recusados), e o servidor Express abaixo.",
        instalar: "npm install @atos.dev.br/entrar\n# Sem npm (página sem empacotador): baixe o mesmo código, um arquivo só, licença MIT:\n#   " + PACOTE +
          (v.ambos ? "\n# No servidor Node, também:\nnpm install express express-session" : v.confidencial ? "\nnpm install express express-session" : ""),
        codigos: v.ambos ? [{ titulo: "Código no navegador (acesso público)", texto: jsNavegador(v) }, { titulo: "Código no servidor Node (acesso confidencial)", texto: JS_SERVIDOR }]
          : [{ titulo: "Código", texto: v.confidencial ? JS_SERVIDOR : jsNavegador(v) }],
      },
      {
        id: "python", nome: "Python", biblioteca: "Authlib (com Flask)", testado: true,
        nota: "Testado contra a Atos: Authlib 1.8.0, Flask 3.1.3, Python 3.14 (quem entra e quem não tem acesso).",
        instalar: "pip install authlib flask requests", codigo: PYTHON,
      },
      {
        id: "dotnet", nome: "C#/.NET", biblioteca: "Microsoft.AspNetCore.Authentication.OpenIdConnect", testado: true,
        nota: "Testado contra a Atos: .NET 10 e o pacote 10.0.11 (quem entra e quem não tem acesso).",
        instalar: "dotnet add package Microsoft.AspNetCore.Authentication.OpenIdConnect", codigo: DOTNET,
      },
      {
        id: "php", nome: "PHP", biblioteca: "league/oauth2-client e firebase/php-jwt", testado: false,
        nota: "Não testado aqui: escrito pela documentação das bibliotecas. (A jumbojett/openid-connect-php não confere ES256, a assinatura da Atos.)",
        instalar: "composer require league/oauth2-client firebase/php-jwt", codigo: PHP,
      },
      {
        id: "java", nome: "Java", biblioteca: "Spring Security OAuth2 Client (Spring Boot 3)", testado: false,
        nota: "Não testado aqui: escrito pela documentação do Spring Security.",
        instalar: "<!-- pom.xml -->\n<dependency>\n  <groupId>org.springframework.boot</groupId>\n  <artifactId>spring-boot-starter-oauth2-client</artifactId>\n</dependency>\n<dependency>\n  <groupId>org.springframework.boot</groupId>\n  <artifactId>spring-boot-starter-web</artifactId>\n</dependency>",
        codigo: JAVA,
      },
      {
        id: "go", nome: "Go", biblioteca: "coreos/go-oidc e golang.org/x/oauth2", testado: false,
        nota: "Não testado aqui: escrito pela documentação das bibliotecas.",
        instalar: "go get github.com/coreos/go-oidc/v3/oidc golang.org/x/oauth2", codigo: GO,
      },
      {
        id: "ruby", nome: "Ruby", biblioteca: "omniauth_openid_connect (Rails)", testado: false,
        nota: "Não testado aqui: escrito pela documentação da gem.",
        instalar: "bundle add omniauth_openid_connect omniauth-rails_csrf_protection", codigo: RUBY,
      },
    ];
  }

  // ------------------------------------------------------------------ o comando que grava o .env

  var aspasSh = function (s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; };
  var aspasPs = function (s) { return "'" + String(s).replace(/'/g, "''") + "'"; };
  var avisoSegredo = function (id) { return "# ATOS_CLIENT_SECRET: cole depois do = o segredo do acesso " + id + " (a Atos o mostra uma vez só). Nunca no repositório."; };

  /* Grava (ou atualiza) no .env da pasta atual ATOS_ISSUER, ATOS_CLIENT_ID e ATOS_REDIRECT_URI e, no confidencial, a
     linha ATOS_CLIENT_SECRET= vazia (so se ainda nao existir; o valor nunca vai no comando). Antes, le a descoberta so
     para conferir que a Atos responde com este emissor. Nao baixa nem executa nada; mantem as outras linhas; avisa se
     o .env nao esta no .gitignore. */
  function comandoEnv(v, tipo) {
    var iss = v.emissor || "https://atos.dev.br";
    if (tipo === "sh") {
      return [
        "# Grava ATOS_ISSUER, ATOS_CLIENT_ID e ATOS_REDIRECT_URI no .env desta pasta" + (v.confidencial ? " (e a linha do segredo, vazia)" : "") + ".",
        "(",
        "  iss=" + aspasSh(iss) + "; cid=" + aspasSh(v.clientId) + "; volta=" + aspasSh(v.volta) + "; conf=" + (v.confidencial ? 1 : 0),
        "  if ! curl -fsS \"$iss/.well-known/openid-configuration\" | grep -q \"\\\"issuer\\\": *\\\"$iss\\\"\"; then",
        "    echo \"A Atos não respondeu em $iss (ou a descoberta diz outro emissor). Nada foi gravado.\" >&2; exit 1",
        "  fi",
        "  [ -f .env ] || : > .env",
        "  tmp=$(mktemp) || exit 1",
        "  awk -v BINMODE=3 -v iss=\"$iss\" -v cid=\"$cid\" -v volta=\"$volta\" -v conf=\"$conf\" -v aviso=" + aspasSh(avisoSegredo(v.clientId)) + " '",
        "    BEGIN { v[\"ATOS_ISSUER\"] = iss; v[\"ATOS_CLIENT_ID\"] = cid; v[\"ATOS_REDIRECT_URI\"] = volta }",
        "    { cr = ($0 ~ /\\r$/) ? \"\\r\" : \"\"; l = $0; sub(/\\r$/, \"\", l); p = \"\"; k = l",
        "      if (match(k, /^[ \\t]*export[ \\t]+/)) { p = \"export \"; k = substr(k, RLENGTH + 1) }",
        "      sub(/^[ \\t]+/, \"\", k); tem = index(k, \"=\"); sub(/[ \\t]*=.*$/, \"\", k)",
        "      if (tem && (k in v)) { print p k \"=\" v[k] cr; feito[k] = 1; next }",
        "      if (tem && k == \"ATOS_CLIENT_SECRET\") seg = 1",
        "      print }",
        "    END { n = split(\"ATOS_ISSUER ATOS_CLIENT_ID ATOS_REDIRECT_URI\", K, \" \")",
        "      for (i = 1; i <= n; i++) if (!(K[i] in feito)) print K[i] \"=\" v[K[i]] cr",
        "      if (conf == 1 && !seg) { print aviso cr; print \"ATOS_CLIENT_SECRET=\" cr } }",
        "  ' .env > \"$tmp\" && cat \"$tmp\" > .env; rm -f \"$tmp\"",
        "  echo \"Gravado em $(pwd)/.env\"",
        "  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git check-ignore -q .env || echo \"Atenção: o .env não está no .gitignore. Acrescente a linha .env antes do próximo commit.\"",
        "  elif ! grep -qsE '^[[:space:]]*(/?\\.env|\\.env\\*|\\*\\.env)[[:space:]]*$' .gitignore; then echo \"Atenção: o .env não está no .gitignore. Acrescente a linha .env.\"; fi",
        ")",
      ].join("\n");
    }
    return [
      "# Grava ATOS_ISSUER, ATOS_CLIENT_ID e ATOS_REDIRECT_URI no .env desta pasta" + (v.confidencial ? " (e a linha do segredo, vazia)" : "") + ". PowerShell 5.1 ou 7.",
      "& {",
      "  $iss = " + aspasPs(iss),
      "  $valores = [ordered]@{ ATOS_ISSUER = $iss; ATOS_CLIENT_ID = " + aspasPs(v.clientId) + "; ATOS_REDIRECT_URI = " + aspasPs(v.volta) + " }",
      "  $confidencial = $" + (v.confidencial ? "true" : "false"),
      "  if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }",
      "  try { $d = Invoke-RestMethod -Uri ($iss + '/.well-known/openid-configuration') } catch { Write-Warning ('A Atos não respondeu em ' + $iss + '. Nada foi gravado.'); return }",
      "  if ($d.issuer -ne $iss) { Write-Warning ('A descoberta diz outro emissor (' + $d.issuer + '). Nada foi gravado.'); return }",
      "  $arq = Join-Path (Get-Location).ProviderPath '.env'",
      "  $linhas = New-Object System.Collections.Generic.List[string]",
      "  $crlf = [string][char]13 + [char]10",
      "  $quebra = [string][char]10",
      "  if (Test-Path -LiteralPath $arq) {",
      "    if ([IO.File]::ReadAllText($arq).Contains($crlf)) { $quebra = $crlf }",
      "    foreach ($l in [IO.File]::ReadAllLines($arq)) { $linhas.Add($l) }",
      "  }",
      "  foreach ($k in @($valores.Keys)) {",
      "    $achou = $false",
      "    for ($i = 0; $i -lt $linhas.Count; $i++) {",
      "      if ($linhas[$i] -match ('^\\s*(export\\s+)?' + $k + '\\s*=')) { $linhas[$i] = [string]$Matches[1] + $k + '=' + $valores[$k]; $achou = $true }",
      "    }",
      "    if (-not $achou) { $linhas.Add($k + '=' + $valores[$k]) }",
      "  }",
      "  if ($confidencial -and -not ($linhas | Where-Object { $_ -match '^\\s*(export\\s+)?ATOS_CLIENT_SECRET\\s*=' })) {",
      "    $linhas.Add(" + aspasPs(avisoSegredo(v.clientId)) + ")",
      "    $linhas.Add('ATOS_CLIENT_SECRET=')",
      "  }",
      "  [IO.File]::WriteAllText($arq, (($linhas -join $quebra) + $quebra), (New-Object System.Text.UTF8Encoding($false)))",
      "  Write-Host ('Gravado em ' + $arq)",
      "  $ignorado = $null",
      "  if (Get-Command git -ErrorAction SilentlyContinue) {",
      "    git rev-parse --is-inside-work-tree 2>$null | Out-Null",
      "    if ($LASTEXITCODE -eq 0) { git check-ignore -q -- .env 2>$null; $ignorado = ($LASTEXITCODE -eq 0) }",
      "  }",
      "  if ($null -eq $ignorado) { $ignorado = (Test-Path -LiteralPath .gitignore) -and [bool](Select-String -LiteralPath .gitignore -Pattern '^\\s*(/?\\.env|\\.env\\*|\\*\\.env)\\s*$' -Quiet) }",
      "  if (-not $ignorado) { Write-Warning 'O .env não está no .gitignore. Acrescente a linha .env antes do próximo commit.' }",
      "}",
    ].join("\n");
  }

  // ------------------------------------------------------------------ o HTML (abas, sem estilo inline)

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  var limpo = function (s) { return String(s).replace(/[^A-Za-z0-9_-]/g, "-"); };

  /* Um bloco com titulo, botao Copiar e o texto. */
  function blocoHtml(titulo, texto, rotulo) {
    return '<div class="il-bloco"><div class="il-cab"><span>' + esc(titulo) + '</span><button type="button" class="btn mini" data-il="copiar">Copiar</button></div>' +
      '<pre class="il-pre" tabindex="0"' + (rotulo ? ' aria-label="' + esc(rotulo) + '"' : "") + ">" + esc(texto) + "</pre></div>";
  }

  /* Abas: itens [{id, rotulo, marca?, html}]; o primeiro aberto. `base` faz os ids unicos na pagina. */
  function abasHtml(base, titulo, itens) {
    base = limpo(base);
    var abas = itens.map(function (it, i) {
      return '<button type="button" role="tab" id="' + base + "-" + it.id + '-aba" aria-controls="' + base + "-" + it.id + '" aria-selected="' + (i === 0) + '"' +
        (i === 0 ? "" : ' tabindex="-1"') + ' data-il="aba">' + esc(it.rotulo) + (it.marca ? ' <span class="il-marca">' + esc(it.marca) + "</span>" : "") + "</button>";
    }).join("");
    var paineis = itens.map(function (it, i) {
      return '<div class="il-painel" role="tabpanel" id="' + base + "-" + it.id + '" aria-labelledby="' + base + "-" + it.id + '-aba"' + (i === 0 ? "" : " hidden") + ">" + it.html + "</div>";
    }).join("");
    return '<div class="il"><div class="il-abas" role="tablist" aria-label="' + esc(titulo) + '">' + abas + "</div>" + paineis + "</div>";
  }

  /* As abas "Escolha a linguagem": as testadas primeiro, as nao testadas marcadas. */
  function linguagensHtml(v, base) {
    return abasHtml(base, "Escolha a linguagem", lista(v).map(function (l) {
      var codigos = l.codigos || [{ titulo: "Código", texto: l.codigo }];
      return {
        id: l.id, rotulo: l.nome, marca: l.testado ? "" : "não testado",
        html: '<p class="il-bib">Biblioteca: <strong>' + esc(l.biblioteca) + "</strong></p>" +
          '<p class="il-nota ' + (l.testado ? "il-testado" : "il-nao-testado") + '">' + esc(l.nota) + "</p>" +
          blocoHtml("Instalação", l.instalar, "Instalação em " + l.nome) +
          codigos.map(function (c) { return blocoHtml(c.titulo, c.texto, c.titulo + " em " + l.nome); }).join(""),
      };
    }));
  }

  /* As abas do .env: PowerShell e Linux/macOS. */
  function envHtml(v, base) {
    return abasHtml(base, "Sistema", [
      { id: "ps", rotulo: "PowerShell", html: blocoHtml("Comando", comandoEnv(v, "ps"), "Comando para PowerShell") },
      { id: "sh", rotulo: "Linux e macOS", html: blocoHtml("Comando", comandoEnv(v, "sh"), "Comando para Linux e macOS") },
    ]);
  }

  raiz.IntegrarLinguagens = { lista: lista, comandoEnv: comandoEnv, PACOTE: PACOTE, esc: esc, blocoHtml: blocoHtml, abasHtml: abasHtml, linguagensHtml: linguagensHtml, envHtml: envHtml };

  // ------------------------------------------------------------------ na pagina: trocar de aba e copiar

  if (typeof document === "undefined" || !document.addEventListener) return;

  function abrir(aba) {
    var grupo = aba.closest(".il");
    if (!grupo) return;
    grupo.querySelectorAll(':scope > .il-abas > [role="tab"]').forEach(function (b) {
      var sim = b === aba;
      b.setAttribute("aria-selected", String(sim));
      if (sim) b.removeAttribute("tabindex"); else b.setAttribute("tabindex", "-1");
      var p = document.getElementById(b.getAttribute("aria-controls"));
      if (p) p.hidden = !sim;
    });
  }

  function copiar(botao) {
    var bloco = botao.closest(".il-bloco");
    var pre = bloco && bloco.querySelector("pre");
    if (!pre) return;
    var avisar = function (texto) {
      var antes = botao.getAttribute("data-rotulo") || botao.textContent;
      botao.setAttribute("data-rotulo", antes);
      botao.textContent = texto;
      setTimeout(function () { botao.textContent = antes; }, 1800);
    };
    var planoB = function () {
      var r = document.createRange(); r.selectNodeContents(pre);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      avisar(ok ? "Copiado" : "Selecionado: Ctrl+C");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.textContent).then(function () { avisar("Copiado"); }, planoB);
    else planoB();
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-il]");
    if (!b) return;
    if (b.getAttribute("data-il") === "aba") abrir(b);
    else if (b.getAttribute("data-il") === "copiar") copiar(b);
  });
  // Setas entre as abas (o padrao de tablist).
  document.addEventListener("keydown", function (e) {
    var b = e.target.closest && e.target.closest('[data-il="aba"]');
    if (!b || (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End")) return;
    var todas = Array.prototype.slice.call(b.parentNode.querySelectorAll('[role="tab"]'));
    var i = todas.indexOf(b);
    var j = e.key === "Home" ? 0 : e.key === "End" ? todas.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + todas.length) % todas.length;
    e.preventDefault();
    todas[j].focus();
    abrir(todas[j]);
  });
})(typeof window !== "undefined" ? window : globalThis);
