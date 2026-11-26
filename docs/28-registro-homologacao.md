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
| 24/11/2026 | Sessão: sem queda por inatividade; termina à meia-noite ou ao fechar o navegador (v18) |
| 24/11/2026 | Controle de caixa no SGI (v18), no modelo das planilhas anuais: caixa por funcionária e Apoio compartilhado (usuário gravado pelo login), entrada com valor do protocolo e valor recebido (troco automático), saídas separadas em repasse/despesa/devolução, nenhum comprovante obrigatório, fechamento com contagem, conferência da Bárbara por um botão no dia seguinte, aprovação final do mês, fluxo de caixa e DRE gerencial, conciliação com extrato do banco, da maquininha e livro de depósito prévio. NFC-e não se aplica |
| 25/11/2026 | Ajustes do caixa (v19): sangria e fechamento do dia só por quem tem a permissão (Bárbara), inclusive na manhã do dia útil seguinte; caixas veem só Frente de caixa e Troco; cada aba do caixa virou permissão na Matriz; pagamento dividido (valor recebido menor que o protocolo, completado em outra forma) |
| 25/11/2026 | Especificação da Oficial (v19): Responsável e Gestor(a) sem pré-seleção (com lista para conferência dos já gravados); aprovação de documentos e projetos exclusiva da Oficial, com autoaprovação registrada; Substituta Legal só com autorização temporária em Configurações → Gestão documental; revisão opcional por uma ou mais revisoras (todas devolvem); aba Em construção; devolver para ajuste com motivo; retirar submissão; exclusão pela Oficial com arquivo guardado pela retenção; documentos no projeto (anexar, vincular, enviar à Gestão documental com origem no projeto, tarefa de revisão) e aprovação do projeto e das fases. Decisões: revisora edita e anexa versão; várias revisoras, todas devolvem; Revisão sempre em branco para escolher; justificativa da autoaprovação opcional; cada envio gera uma nova versão inteira |
| 26/11/2026 | Solicitações à administração (v20): campo de anexo abaixo da descrição do pedido (até 5 arquivos, antivírus e hash, anexo imutável, download auditado); tipo Atestado / ausência com período e anexo obrigatório, visível só a quem pediu, à Oficial e a quem atende e lança ausências (dado de saúde, LGPD art. 11); ao atender, a ausência é lançada na ficha e os dias abonados no ponto, com link para o pedido |
| 24/11/2026 | Segurança: Next.js 16.4.6 e zod 4.6.7 (correções de vulnerabilidades conhecidas) |
| 02/11/2026 | Financeiro: **ninguém vê nada além do que a Oficial habilitar** — por pessoa, *todo o financeiro* (administração) ou centros de custo escolhidos (v16). A Substituta passa a depender de habilitação |
| 02/11/2026 | Solicitações: aba **À administração** para todas as pessoas (pedidos livres com conversa e resposta), atendidas pela Oficial e pela Substituta; opção "somente para a Oficial" (v16) |
| 30/10/2026 | Segundo fator: além do aplicativo, **códigos de reserva** para todos e **código por e-mail pessoal** liberado pela Oficial pessoa a pessoa (v14). SMS descartado (custo e clonagem de chip); WhatsApp (API oficial da Meta) fica para depois da verificação da empresa na Meta |
| 30/10/2026 | Regras da CCT SC000957/2026: a conferência e a validação no sistema são feitas pela **Oficial, como empregadora** (nome e cargo), sem exigência de advogado(a) — não há norma que a imponha; dúvidas de interpretação podem ser levadas ao jurídico do SINOREG-SC. A v12 pré-cadastra as regras da CCT (pendentes) e acrescenta a cl. 17, §2º (folga integral começa na segunda ou sexta) e §§5º–6º (sábado, domingo e feriado fora do banco, salvo plantão, casamento e curso/palestra até 4 sábados/ano) |

## Pendências para a produção

- Confirmar com a Ateky se o IP é fixo (ou contratar IP fixo).
- Decidir o tratamento do banco de horas anterior à implantação (recomendação: quitar até a data da implantação).
- P-04 (convenção coletiva e acordos), P-05 (validação jurídica dos itens J) e P-06 (encarregado de dados — LGPD).
- Aceite formal por escrito da Oficial ao fim do roteiro e autorização expressa para publicar em produção.
