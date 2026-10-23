# ADR 0012 — Financeiro gerencial

**Situação:** aceita (Fase 4b, 22/10/2026).

- **Natureza:** controle **gerencial** interno. Não substitui a escrituração obrigatória, o Livro Diário Auxiliar nem os controles formais da serventia; a integração com essas obrigações depende de validação jurídica e contábil (pendência J-16). Receitas são lançamento gerencial manual, não apuração de emolumentos.
- **Valores:** `numeric(14,2)` no banco e **centavos inteiros** na aplicação (sem ponto flutuante); entrada no formato brasileiro (1.234,56).
- **Fluxo:** solicitação → aprovação/rejeição → pagamento. **Segregação em três papéis:** quem solicita não aprova; quem solicita ou aprova não paga — verificado no serviço **e no banco** (CHECK e gatilho no registro do pagamento). Aprovação e pagamento exigem reautenticação. Pagamento único, imutável, com valor igual ao aprovado e comprovante anexado (parâmetro). Despesa paga, rejeitada ou cancelada é imutável; despesa aprovada não muda valor, fornecedor, classificação nem partes.
- **Consequência prática:** são necessárias **pelo menos três pessoas** com papéis financeiros distintos para que toda despesa possa ser paga. O painel avisa quando uma despesa aprovada fica sem pagador possível (ex.: apenas Oficial e Substituta com permissões financeiras).
- **Limite de aprovação delegada** (parâmetro, padrão desativado): acima do valor, só a Oficial aprova.
- **Compras:** justificativa obrigatória; cotações; a escolhida define o valor; escolher outra que não a de menor valor exige justificativa. Número mínimo de cotações não foi presumido.
- **Contratos:** mensalidades lançadas por competência de forma idempotente, seguindo o mesmo fluxo de aprovação; vencimento nunca antes do início do contrato; alerta de término pelo prazo de aviso. Reajustes não são calculados (registra-se a regra do contrato).
- **Fornecedores:** CNPJ/CPF validados, cifrados (AES-256-GCM) e únicos por HMAC; a tela mostra apenas os 4 últimos dígitos; exibição completa é auditada.
- **Relatórios:** fluxo de caixa (regime de caixa), previsto × realizado (realizado = pago; comprometido = aprovado), por categoria, centro de custo e setor, projeção de 6 meses (maior entre orçamento e o já conhecido), CSV com neutralização de fórmulas. Custo de pessoal (salários-base vigentes) somente para quem vê salários; encargos não presumidos.
- **Escopo:** coordenação vê e solicita apenas nos centros de custo do próprio setor, sem receitas nem custo de pessoal.
- **Projetos:** despesas pagas vinculadas a um projeto somam-se ao custo realizado do projeto.
