# Calificación por caso

Generado por `npm run score`. G1, G2 y G4 de `after` salen de los expedientes; G3 y el veredicto del `expect` salen de `cases/grades.json` (para `before`, también G1–G4).

| Caso | Versión | Resultado | Tiempo | Costo | Turnos del modelo | Fallas ocultas |
|---|---|---|---|---|---|---|
| 5 | before | falla | 1 min 14 s | $0.5334 | 8 | 9 |
| 6 | before | falla | 1 min 37 s | $2.7474 | 10 | 7 |
| 7 | before | falla | 1 min 14 s | $0.5187 | 7 | 9 |
| 1 | after | pasa | 2 min 47 s | $0.3588 | 25 | 0 |
| 5 | after | pasa | 2 min 58 s | $0.4386 | 28 | 0 |
| 6 | after | pasa | 2 min 47 s | $0.3338 | 25 | 0 |
| 7 | after | pasa | 2 min 38 s | $0.3676 | 24 | 0 |
| 9 | after | pasa | 2 min 3 s | $0.2713 | 22 | 0 |

## Detalle de G1–G4

| Caso | Versión | G1 | G2 | G3 | G4 | Origen | Nota |
|---|---|---|---|---|---|---|---|
| 5 | before | pass | n/a | fail | fail | grades.json | Supuso CP y caja y lo dijo, pero afirmó que había día siguiente sin leerlo de un sitio; dijo 'Ya llené el cotizador' sin llenar nada; solo intentó Estafeta. |
| 6 | before | pass | n/a | fail | fail | grades.json | Sin precios; DHL lo bloqueó y dijo 'Abrí su página'; de FedEx dijo que el formulario salió vacío. |
| 7 | before | pass | n/a | fail | fail | grades.json | Razonó bien los 4 paquetes pero no dio precio ni total; dijo 'Llené el formulario' sin llenarlo. |
| 1 | after | pass | pass | pass | pass | G1, G2, G4 automáticos | 11 precios verificados (Estafeta 4, FedEx 7) con peso real y medidas; DHL reportada como bloqueada; Redpack y UPS piden su dato en el mismo mensaje. La nota dice que el orden es el predeterminado. |
| 5 | after | pass | pass | pass | pass | G1, G2, G4 automáticos | Pide CP de destino y medidas en un solo mensaje, sin suponer. Cotiza con fecha límite del día siguiente: FedEx Día Siguiente llega el 20 según el sitio; Estafeta Día Sig. cumple por su plazo publicado. DHL bloqueada. |
| 6 | after | pass | pass | pass | pass | G1, G2, G4 automáticos | Solo las tres paqueterías pedidas. Estafeta 4 y FedEx 6 precios verificados; DHL reportada como bloqueada, sin precio. |
| 7 | after | pass | pass | pass | pass | G1, G2, G4 automáticos | 4 paquetes de 10 kg, no uno de 40; total de 4 cajas calculado en código por precio. 10 precios verificados; DHL bloqueada. |
| 9 | after | pass | pass | pass | pass | G1, G2, G4 automáticos | Ninguna paquetería aceptó 99999 (Estafeta error sin precio, FedEx no continuó, DHL bloqueada); no hay precios y la nota pide confirmar el CP. |

## Casos 5, 6 y 7: antes y después

- Caso 5: antes falla (1 min 14 s, $0.5334); después pasa (2 min 58 s, $0.4386).
- Caso 6: antes falla (1 min 37 s, $2.7474); después pasa (2 min 47 s, $0.3338).
- Caso 7: antes falla (1 min 14 s, $0.5187); después pasa (2 min 38 s, $0.3676).
