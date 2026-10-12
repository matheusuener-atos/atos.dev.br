/** Quem entrou, depois de a Atos e o id_token serem conferidos. */
export interface PessoaAtos {
  /** O identificador fixo da Conta Atos (o claim sub). Use este para identificar a pessoa. */
  id: string;
  /** O nome (escopo profile), ou "". */
  nome: string;
  /** O e-mail (escopo email), ou "". Pode mudar: só para mostrar. */
  email: string;
  emailVerificado: boolean;
  idToken: string;
  /** Para /oauth/userinfo e para sair(). Vale 1 hora; não há refresh_token. */
  accessToken: string;
  /** Quando o id_token vence (milissegundos desde 1970). */
  expiraEm: number;
}

/** O que comecar() devolve para guardar na sessão do usuário até a volta. */
export interface IdaAtos {
  state: string;
  nonce: string;
  verifier: string;
  voltaPara: string;
  criado: number;
}

export interface OpcoesAtos {
  /** O client_id do acesso cadastrado na Atos. */
  clientId: string;
  /** O endereço de volta, exatamente como cadastrado. */
  voltaPara: string;
  /** Padrão ["openid", "email", "profile"]; openid sempre vai. */
  escopos?: Array<"openid" | "email" | "profile">;
  /** Só para testes. Padrão https://atos.dev.br. */
  emissor?: string;
  fetch?: typeof fetch;
}

export interface ExtraDaIda {
  /** "none" tenta sem mostrar tela; "login" pede a senha de novo; "consent" pede a permissão de novo; "create" = criarConta. */
  prompt?: "none" | "login" | "consent" | "create";
  /**
   * Abre a Atos em "Criar a conta Atos" (prompt=create), com "Já tem conta? Entrar" no mesmo pedido.
   * Quem já está com a sessão aberta na Atos segue direto para a permissão (ou a volta). Não combina com prompt.
   * Numa Atos que não anuncia "create" na descoberta, vai à tela de entrar de sempre.
   */
  criarConta?: boolean;
  /** O e-mail sugerido na tela de entrar (login_hint). */
  dica?: string;
}

export interface ClienteAtos {
  /** Navegador: vai à Atos (guarda state, nonce e code_verifier em sessionStorage). */
  entrar(extra?: ExtraDaIda): Promise<void>;
  /** Navegador, na página de volta: a pessoa, ou null se o endereço não é uma volta. Lança ErroAtos. */
  retorno(endereco?: string): Promise<PessoaAtos | null>;
  /** Servidor: o endereço da Atos e o que guardar na sessão. */
  comecar(extra?: ExtraDaIda): Promise<{ url: string; guardar: IdaAtos }>;
  /** Servidor: confere a volta (o segredo vem de process.env.ATOS_CLIENT_SECRET). Lança ErroAtos. */
  concluir(urlDaVolta: string, guardado: IdaAtos): Promise<PessoaAtos>;
  /** Invalida o access_token na Atos. */
  sair(accessToken: string): Promise<void>;
  /**
   * Navegador: "Continuar como <nome>" pelo FedCM (Chrome e Edge). Sem params: devolve a pessoa (cliente público).
   * Com params (de comecarFedCM() no servidor): devolve { codigo } para o servidor chamar concluirFedCM().
   * Sem FedCM no navegador, ou fechando a janela no modo "ativo": vai pelo redirecionamento e devolve null.
   * Lança ErroAtos (access_denied quando a conta não está liberada no aplicativo).
   */
  continuarComFedCM(opcoes?: OpcoesFedCM & { params?: undefined }): Promise<PessoaAtos | null>;
  continuarComFedCM(opcoes: OpcoesFedCM & { params: ParamsFedCM }): Promise<{ codigo: string } | null>;
  /** O nonce e o code_challenge da ida pelo FedCM (no servidor), e o que guardar na sessão até concluirFedCM(). */
  comecarFedCM(): Promise<{ params: ParamsFedCM; guardar: IdaFedCM }>;
  /** Troca o código que o FedCM entregou (sem redirect_uri; no servidor, com ATOS_CLIENT_SECRET) e confere o id_token. */
  concluirFedCM(codigo: string, guardado: IdaFedCM): Promise<PessoaAtos>;
  /** Tira a permissão deste aplicativo na Atos (IdentityCredential.disconnect). false sem FedCM. */
  desconectarFedCM(conta: string): Promise<boolean>;
  /** O navegador tem o FedCM? */
  temFedCM(): boolean;
  readonly clientId: string;
  readonly voltaPara: string;
  readonly emissor: string;
}

export interface ParamsFedCM { nonce: string; desafio: string }
export interface IdaFedCM { fedcm: true; nonce: string; verifier: string; criado: number }
export interface OpcoesFedCM {
  /** "ativo" (padrão; chame no clique de um botão) ou "passivo" (o aviso do navegador ao abrir a página). */
  modo?: "ativo" | "passivo";
  /** O texto da janela do navegador: "signin" (padrão), "signup", "use" ou "continue". */
  contexto?: "signin" | "signup" | "use" | "continue";
  /** O e-mail esperado (loginHint). */
  dica?: string;
  /** Sem FedCM ou com a janela fechada: o endereço do login de sempre (padrão: entrar(extra)); false não redireciona. */
  semFedCM?: string | false;
  /** O que vai para entrar() quando cai no redirecionamento. */
  extra?: ExtraDaIda;
}

export class ErroAtos extends Error {
  /** access_denied, login_required, consent_required, state, iss, id_token, invalid_grant, invalid_client, rede, descoberta, configuracao... */
  codigo: string;
  /** O error_description da Atos, quando veio. */
  descricao?: string;
}

export function entrarComAtos(opcoes: OpcoesAtos): ClienteAtos;

/** Um aviso da Atos ao seu sistema (Atos Workspace > Integracoes > Avisos ao seu sistema). */
export interface AvisoAtos {
  /** O id do aviso (o mesmo em toda tentativa: guarde para nao aplicar duas vezes). */
  id: string;
  tipo: "acesso.revogado" | "liberado.adicionado" | "liberado.removido" | "aviso.teste";
  /** Quando o aviso nasceu (ISO 8601). */
  criado: string;
  /** O id do aplicativo na Atos (u-...). */
  app: string;
  /** acesso.revogado: {sub}; liberado.*: {pessoas: [{email, sub?}]}; aviso.teste: {}. */
  dados: { sub?: string; pessoas?: { email: string; sub?: string }[] };
}

/** Confere a assinatura (Atos-Assinatura) e a idade (5 minutos) de um aviso; `corpo` e o texto cru. Lanca ErroAtos (codigo "aviso"). */
export function verificarAviso(corpo: string, cabecalho: string | null | undefined, segredo: string, opcoes?: { agora?: number }): Promise<AvisoAtos>;
/** As opções do botão oficial (https://atos.dev.br/marca/). */
export interface OpcoesDoBotao {
  /** Padrão "claro". */
  tema?: "claro" | "escuro" | "neutro";
  /** grande 56 px, medio 48 px (padrão), pequeno 44 px de altura. */
  tamanho?: "grande" | "medio" | "pequeno";
  /** "Entrar com Atos" (padrão), "Continuar com Atos" ou "Criar conta com Atos". */
  texto?: "entrar" | "continuar" | "criar-conta";
  /** O destino do link (padrão "#"). javascript:, data: e vbscript: lançam ErroAtos. */
  href?: string;
  /** Só o quadrado (o texto fica para leitores de tela). */
  icone?: boolean;
  /** A largura toda. */
  largo?: boolean;
  id?: string;
}

/** O HTML do botão oficial (um <a>, sem script nem estilo inline). Precisa da folha https://atos.dev.br/marca/botao.css (ou "@atos.dev.br/entrar/botao.css"). */
export function botaoEntrarComAtos(opcoes?: OpcoesDoBotao): string;
export default entrarComAtos;
