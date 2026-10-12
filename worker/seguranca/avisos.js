// Os avisos por e-mail das mudancas na seguranca da Conta Atos (Resend, worker/email.js), ao e-mail cadastrado da conta.
// Sem link nenhum: um e-mail de seguranca que pede para clicar e digitar a senha e o que o golpe faz, entao a Atos nao
// ensina esse caminho. So o que mudou, quando, de onde, e "se nao foi voce, escreva para contato@atos.dev.br".

import { enviarEmail } from "../email.js";
import { deOnde } from "./atividade.js";

const TEXTOS = {
  "totp-ligada": ["A verificação em duas etapas foi ligada", "A verificação em duas etapas pelo aplicativo autenticador foi ligada na sua Conta Atos. A partir de agora, depois da senha, a Atos pede o código do aplicativo (ou um código de recuperação, ou uma chave de acesso)."],
  "totp-desligada": ["O aplicativo autenticador foi desligado", "O aplicativo autenticador foi desligado da verificação em duas etapas da sua Conta Atos."],
  "chave-cadastrada": ["Uma chave de acesso foi cadastrada", "Uma chave de acesso foi cadastrada na sua Conta Atos. Com ela, dá para entrar sem a senha e confirmar a segunda etapa."],
  "chave-removida": ["Uma chave de acesso foi removida", "Uma chave de acesso foi removida da sua Conta Atos."],
  "codigos-gerados": ["Novos códigos de recuperação", "Novos códigos de recuperação foram gerados na sua Conta Atos. Os códigos de antes não valem mais."],
  "codigo-usado": ["Um código de recuperação foi usado", "Um código de recuperação foi usado para entrar na sua Conta Atos. Cada código vale uma vez só."],
  "senha-trocada": ["A senha da sua Conta Atos foi trocada", "A senha da sua Conta Atos foi trocada. As sessões abertas antes da troca foram encerradas."],
  "segunda-desligada": ["A verificação em duas etapas está desligada", "A sua Conta Atos não tem mais nenhuma segunda etapa (nem aplicativo autenticador, nem chave de acesso): agora basta a senha para entrar. Os códigos de recuperação foram apagados."],
  // As acoes da equipe (painel, Contas Atos; worker/admin-contas.js). O terceiro texto troca o fecho: nao foi a pessoa
  // que fez, entao "se foi voce" nao cabe.
  "equipe-2fa-desligada": ["A equipe da Atos desligou a verificação em duas etapas", "Atendendo a um pedido feito a contato@atos.dev.br, a equipe da Atos desligou a verificação em duas etapas da sua Conta Atos: o aplicativo autenticador, os códigos de recuperação e as chaves de acesso foram removidos. Agora basta a senha para entrar. Ligue de novo em Minha conta › Segurança assim que puder.",
    "Se você não pediu isso, escreva agora para contato@atos.dev.br. Este e-mail não tem link de propósito: a Atos nunca pede a sua senha por e-mail."],
  "equipe-sessoes-encerradas": ["A equipe da Atos encerrou as sessões da sua conta", "A equipe da Atos encerrou todas as sessões abertas da sua Conta Atos. Para usar a conta, entre de novo.",
    "Se você não esperava por isso, escreva para contato@atos.dev.br. Este e-mail não tem link de propósito: a Atos nunca pede a sua senha por e-mail."],
};

export const quandoBr = (ms) => new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) + " (horário de Brasília)";

/* Manda o aviso `evento` (TEXTOS) a `email`. `detalhe`: uma linha a mais (o nome da chave, os codigos que restam). Nunca
   impede a mudanca: se o e-mail nao sai, a mudanca ja foi feita. */
export async function avisar(env, deps, email, evento, { agora = Date.now(), request, detalhe = "" } = {}) {
  const t = TEXTOS[evento];
  if (!t || !email) return;
  const o = deOnde(request);
  const de = [o.navegador, o.onde].filter(Boolean).join(", ");
  const texto = t[1] + (detalhe ? "\n\n" + detalhe : "") +
    "\n\nQuando: " + quandoBr(agora) + "." + (de ? "\nDe: " + de + " (aproximado)." : "") +
    "\n\n" + (t[2] || "Se foi você, não precisa fazer nada. Se não foi, escreva agora para contato@atos.dev.br. Este e-mail não tem link de propósito: a Atos nunca pede a sua senha por e-mail.");
  try {
    await (deps && deps.enviarEmail ? deps.enviarEmail : enviarEmail)(env, { para: email, assunto: t[0] + " · Conta Atos", titulo: t[0], texto });
  } catch {
    // o aviso nao desfaz a mudanca
  }
}
