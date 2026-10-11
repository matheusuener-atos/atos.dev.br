// Os e-mails da conta Atos (os codigos), pelo Resend. Saem de
// naoresponda@atos.dev.br e a resposta vai para contato@atos.dev.br. O dominio
// atos.dev.br precisa estar verificado no Resend (os registros DNS que ele
// pede, no Cloudflare). Sem RESEND_API_KEY, nada sai e a rota diz isso.

const DE = "Atos <naoresponda@atos.dev.br>";
const RESPONDER = "contato@atos.dev.br";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function htmlDoEmail({ titulo, texto, pre }) {
  const paragrafos = String(texto || "").split(/\n\n+/).map((p) => '<p style="margin:0 0 16px">' + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head>' +
    '<body style="margin:0;padding:0;background:#faf9f6;color:#1c1c1a">' +
    (pre ? '<div style="display:none;max-height:0;overflow:hidden">' + esc(pre) + "</div>" : "") +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">' +
    '<tr><td style="font-family:\'Times New Roman\',Times,serif;font-size:34px;line-height:1;padding-bottom:32px">Atos</td></tr>' +
    '<tr><td style="font-family:\'Times New Roman\',Times,serif;font-size:24px;padding-bottom:16px">' + esc(titulo) + "</td></tr>" +
    '<tr><td style="font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;font-size:15px;line-height:1.55;color:#3c3b37">' + paragrafos + "</td></tr>" +
    '<tr><td style="font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;font-size:12px;color:#75736c;padding-top:24px;border-top:1px solid #e3e1da">' +
    "Atos · atos.dev.br · Este endereço não recebe respostas; escreva para " + RESPONDER + ".</td></tr>" +
    "</table></td></tr></table></body></html>";
}

/* anexos (opcional): [{nome, b64}] - a NFS-e manda o PDF e o XML (nfse/atos.js). */
/* Os dominios reservados para teste e exemplo (RFC 2606 e 6761): os clientes de exemplo do Worker de teste
   (nfse/semente.js) usam @exemplo.test. Para eles nada sai, em nenhum ambiente. */
export function enderecoDeTeste(para) {
  const dominio = String(para || "").trim().toLowerCase().split("@").pop().replace(/\.$/, "");
  return /(^|\.)(test|example|invalid|localhost)$/.test(dominio) || /(^|\.)example\.(com|net|org)$/.test(dominio);
}

export async function enviarEmail(env, { para, assunto, titulo, texto, pre, anexos }) {
  if (enderecoDeTeste(para)) return { ok: false, status: 400, erro: "endereço reservado para testes: nada sai" };
  if (!env.RESEND_API_KEY) return { ok: false, status: 503, erro: "o envio de e-mail ainda não está ligado" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_DE || DE, reply_to: RESPONDER, to: [para], subject: String(assunto || "").slice(0, 200),
        html: htmlDoEmail({ titulo, texto, pre }), text: [titulo, texto, "Atos · atos.dev.br"].filter(Boolean).join("\n\n"),
        ...(Array.isArray(anexos) && anexos.length ? { attachments: anexos.map((a) => ({ filename: String(a.nome || "anexo"), content: String(a.b64 || "") })) } : {}) }),
    });
    if (!r.ok) return { ok: false, status: 502, erro: "o provedor de e-mail recusou" };
    return { ok: true };
  } catch {
    return { ok: false, status: 502, erro: "o provedor de e-mail não respondeu" };
  }
}
