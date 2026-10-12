// O menu de conta da Loja da Maria: o HTML veio do servidor (menuContaAtos); aqui só o comportamento (abrir e fechar,
// as setas, o Esc e a caixa "Sair da conta?" antes do POST /sair, que sai da Loja, não da Atos).
import { ligarMenuContaAtos } from "/atos/entrar.js";

const lugar = document.getElementById("conta");
if (lugar) ligarMenuContaAtos(lugar, { tema: "claro", sair: "/sair", confirmarSair: true });
