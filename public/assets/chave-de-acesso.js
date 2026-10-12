/* As chaves de acesso (passkeys, WebAuthn) no navegador: converte as opcoes que o Worker manda (base64url) para o que
   navigator.credentials pede (ArrayBuffer) e a resposta de volta para JSON. Quem confere tudo e o Worker
   (worker/seguranca/webauthn.js). Usado pelo /entrar, pelo /workspace/entrar e pela Minha conta > Seguranca. */
(function () {
  "use strict";
  function deB64url(s) {
    var b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
    var u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  }
  function b64url(buf) {
    if (!buf) return "";
    var u = new Uint8Array(buf), s = "";
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function lista(l) {
    return (l || []).map(function (c) { var x = { type: "public-key", id: deB64url(c.id) }; if (c.transports) x.transports = c.transports; return x; });
  }
  /* O motivo, em portugues, de o navegador nao ter terminado. */
  function motivo(e) {
    var n = e && e.name;
    if (n === "NotAllowedError" || n === "AbortError") return "a chave de acesso foi cancelada ou o tempo acabou";
    if (n === "InvalidStateError") return "esta chave de acesso já está cadastrada nesta conta";
    if (n === "NotSupportedError") return "este aparelho não oferece uma chave de acesso compatível";
    if (n === "SecurityError") return "as chaves de acesso não funcionam neste endereço";
    return "a chave de acesso não respondeu: tente de novo";
  }

  window.AtosChave = {
    disponivel: function () { return Boolean(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); },
    motivo: motivo,
    /* navigator.credentials.create com as opcoes do Worker (/api/seguranca/chaves/opcoes). */
    criar: function (pk) {
      var o = {
        challenge: deB64url(pk.challenge), rp: pk.rp, pubKeyCredParams: pk.pubKeyCredParams, timeout: pk.timeout, attestation: pk.attestation,
        authenticatorSelection: pk.authenticatorSelection, excludeCredentials: lista(pk.excludeCredentials),
        user: { id: deB64url(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      };
      return navigator.credentials.create({ publicKey: o }).then(function (c) {
        var t = c.response.getTransports ? c.response.getTransports() : [];
        return { id: c.id, rawId: b64url(c.rawId), type: c.type,
          response: { clientDataJSON: b64url(c.response.clientDataJSON), attestationObject: b64url(c.response.attestationObject), transports: t } };
      });
    },
    /* navigator.credentials.get com as opcoes do Worker (/api/chave/opcoes, /api/segunda-etapa/opcoes). */
    obter: function (pk) {
      var o = { challenge: deB64url(pk.challenge), rpId: pk.rpId, timeout: pk.timeout, userVerification: pk.userVerification, allowCredentials: lista(pk.allowCredentials) };
      return navigator.credentials.get({ publicKey: o }).then(function (c) {
        return { id: c.id, rawId: b64url(c.rawId), type: c.type,
          response: { clientDataJSON: b64url(c.response.clientDataJSON), authenticatorData: b64url(c.response.authenticatorData),
            signature: b64url(c.response.signature), userHandle: c.response.userHandle ? b64url(c.response.userHandle) : "" } };
      });
    },
  };
})();
