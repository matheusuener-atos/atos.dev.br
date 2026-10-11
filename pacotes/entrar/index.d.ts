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
  readonly clientId: string;
  readonly voltaPara: string;
  readonly emissor: string;
}

export class ErroAtos extends Error {
  /** access_denied, login_required, consent_required, state, iss, id_token, invalid_grant, invalid_client, rede, descoberta, configuracao... */
  codigo: string;
  /** O error_description da Atos, quando veio. */
  descricao?: string;
}

export function entrarComAtos(opcoes: OpcoesAtos): ClienteAtos;
export default entrarComAtos;
