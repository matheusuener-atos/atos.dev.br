# Entrar com Atos num servidor Python (Flask) com o Authlib: cliente confidencial, PKCE S256.
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
