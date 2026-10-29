# Registro da homologação (ambiente `sgi-orcb-homolog`, dados fictícios)

Executada pela Oficial Registradora (conta institucional) com apoio da Substituta (Barbara), seguindo `25-roteiro-homologacao.md`.
Ambiente: Google Cloud, região São Paulo, publicado pelo caminho sem chave (`deploy/gcp-homolog.sh`) em 24/10/2026.

## Resultado por item

| Item | Resultado | Observação |
|---|---|---|
| 1.1 Entrar, sair, página protegida | ✅ | |
| 1.2 Usuários e permissões, suspensão imediata | ✅ | |
| 1.3 Auditoria íntegra | ✅ | |
| 2.1 Admissão com jornada e acordo | ✅ | |
| 2.2 Marcações, correção, compensação | ✅ | Compensação sem saldo recusada pela regra do acordo (comportamento correto) |
| 2.3 Ocorrências e decisões | ✅ | |
| 2.4 Espelho, extrato, manifestações, fechamento | ✅ | Documentos gerados pelo próprio funcionário |
| 3.1 Férias | ✅ | Revelou a falta de “situação inicial” (ver Ajustes) |
| 3.2 Plantões RCPN | ✅ | |
| 3.3 Checklist e termo de entrega | ✅ ⚠️ | Situação do termo na ficha (ajustado na v6) |
| 4.1 POP: elaboração, aprovação, ciência | ✅ | |
| 4.2 Documento confidencial | ✅ | |
| 4.3 Antivírus | ✅ | Arquivo limpo verificado na nuvem; EICAR não testado no laptop (o antivírus do Windows o remove) — coberto pelos testes automatizados |
| 5.1 Tarefa com aprovação | ✅ | |
| 5.2 Rotina diária | ✅ | |
| 5.3 Projeto (Gantt) e processo | ✅ | |
| 6.1 Despesa: solicitar, aprovar, pagar | ✅ | Após decisão sobre a segregação (ver abaixo) |
| 6.2 Compra, contrato, orçamento, relatório | ✅ | |
| Rede da serventia | ✅ parcial | Endereço lido corretamente e restrição ativada; teste pelo celular (4G) não realizado |

## Ajustes feitos durante a homologação

- **v4:** aviso à Oficial e à Substituta quando várias pessoas são recusadas a partir de um endereço novo (troca do IP do cartório).
- **v5:** início do controle no sistema e férias anteriores à implantação (funcionários já em atividade); faltas do controle anterior na conferência do art. 130; formulários deixam de perder os dados quando o servidor recusa.
- **v6:** situação do termo de entrega na ficha do funcionário.
- **v7:** a Oficial pode solicitar, aprovar e pagar despesas (parâmetro).
- **v8:** painel do financeiro mostra à Oficial as despesas em que ela participou (complemento da v7).
- **v9:** Relatórios → *Gerar relatório XLS Asgard*: modelo do Asgard preenchido com as despesas pagas no mês (pedido da Oficial, 29/10/2026).
- **v10:** despesas fixas mensais sem contrato (editáveis/excluíveis) e importação da planilha do Asgard; geração mensal já com o tipo do Asgard. A planilha real de setembro/2026 **não** foi carregada na homologação (contém salários): será importada na produção.

## Decisões da Oficial

| Data | Decisão |
|---|---|
| 28/10/2026 | Ativar a restrição de rede com o endereço atual (177.74.69.168, Ateky), mesmo sem confirmação de IP fixo; se mudar, a Substituta atualiza em Configurações → Rede |
| 28/10/2026 | Financeiro: a Oficial pode solicitar, aprovar e pagar a mesma despesa (`financeiro.oficial_sem_segregacao`); demais pessoas mantêm a regra das três pessoas |
| 29/10/2026 | Gestão documental: **mantida** a aprovação por outra pessoa também para documentos elaborados pela Oficial |

## Pendências para a produção

- Confirmar com a Ateky se o IP é fixo (ou contratar IP fixo).
- Decidir o tratamento do banco de horas anterior à implantação (recomendação: quitar até a data da implantação).
- P-04 (convenção coletiva e acordos), P-05 (validação jurídica dos itens J) e P-06 (encarregado de dados — LGPD).
- Aceite formal por escrito da Oficial ao fim do roteiro e autorização expressa para publicar em produção.
