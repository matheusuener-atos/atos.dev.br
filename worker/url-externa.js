// Os enderecos de fora que a Atos chama ou para onde manda alguem, conferidos antes de guardar: os avisos ao sistema
// (worker/avisos.js), as paginas de status (worker/status.js) e o "obrigado" dos formularios (worker/formularios.js).
//
// A regra (contra usar a Atos para chegar onde nao devia - SSRF - ou contra ela mesma): so https, na porta padrao; o
// nome do servidor com pelo menos um ponto e um dominio de topo de letras; nada de endereco IP escrito (v4 ou v6), de
// localhost, de nomes de rede interna (.local, .internal, .lan, .home.arpa...) ou reservados (.test, .example,
// .invalid, .localhost, .onion); nada da propria Atos (atos.dev.br e os subdominios, os *.workers.dev da Atos) nem de
// usuario e senha no endereco. O Worker so sai para a internet publica (a Cloudflare nao chega a rede privada de
// ninguem), e a chamada nao segue redirecionamentos (redirect: "manual"): um 301 para um endereco interno nao e seguido.

const RESERVADOS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private|home\.arpa|test|example|invalid|onion|arpa)$/;
const DA_ATOS = /(^|\.)(atos\.dev\.br|matheusuener\.com\.br)$/;

/* {url} (o texto normalizado) ou {erro}. `contexto`: o que aparece na mensagem ("o endereço do aviso"). */
export function conferirUrlExterna(bruto, { contexto = "o endereço", max = 500 } = {}) {
  const t = String(bruto == null ? "" : bruto).trim();
  if (!t) return { erro: "informe " + contexto };
  if (t.length > max) return { erro: contexto + " passa de " + max + " caracteres" };
  let u;
  try {
    u = new URL(t);
  } catch {
    return { erro: contexto + " não é um endereço válido (ex.: https://exemplo.com.br/caminho)" };
  }
  if (u.protocol !== "https:") return { erro: contexto + " precisa começar com https://" };
  if (u.username || u.password) return { erro: contexto + " não pode ter usuário nem senha" };
  if (u.port && u.port !== "443") return { erro: contexto + " precisa usar a porta padrão do https" };
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!h || h.startsWith("[") || /^[\d.]+$/.test(h) || h.includes(":")) return { erro: contexto + " precisa ter um nome (não um endereço IP)" };
  if (!/^[a-z0-9.-]+$/.test(h) || !/\.[a-z]{2,63}$/.test(h)) return { erro: contexto + " precisa ter um nome de domínio público" };
  if (RESERVADOS.test(h)) return { erro: contexto + " aponta para uma rede interna ou um nome reservado" };
  if (DA_ATOS.test(h) || /(^|\.)atos(-teste)?\.[a-z0-9-]+\.workers\.dev$/.test(h)) return { erro: contexto + " não pode ser da própria Atos" };
  u.hash = "";
  return { url: u.toString() };
}

/* A origem de um site (https://exemplo.com.br, sem caminho) para o CORS dos formularios: https, ou http so em
   localhost, 127.0.0.1 e [::1] (para testar na propria maquina). {origem} ou {erro}. */
export function conferirOrigem(bruto) {
  const t = String(bruto == null ? "" : bruto).trim().replace(/\/$/, "");
  if (!t) return { erro: "informe o site" };
  let u;
  try {
    u = new URL(t);
  } catch {
    return { erro: "“" + t.slice(0, 80) + "” não é um site válido (ex.: https://exemplo.com.br)" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return { erro: "o site precisa começar com https:// (http:// só em localhost e 127.0.0.1, para testar)" };
  if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) return { erro: "“" + t.slice(0, 80) + "”: informe só a origem (ex.: https://exemplo.com.br), sem caminho" };
  return { origem: u.origin };
}
