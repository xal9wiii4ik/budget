# Alfa-Bank (BY) PDF statement — STRUCTURE of the owner's sample (no values)

Source: `.tasks/pdf-reconcile/real-alfa-local.pdf` (gitignored, NEVER commit, never
copy values from it). Inspected 2026-10-14 by senior-lead with pypdf 6 / pdfplumber
in a scratch venv. Everything below is layout, labels and number FORMATS only;
committed fixtures must be synthetic look-alikes with invented merchants, amounts,
dates and ids.

## File facts
- Text-based PDF (producer iText 5.5.12), NOT scanned; 2 pages, ~1.6k + 2.4k chars
  of extractable text. Page footer `N / N`.
- `pypdf` plain `extract_text()` yields ONE LINE PER OPERATION even when the PDF
  visually wraps a long description (layout mode wraps; plain mode joins). Plain
  mode is the right input for the LLM. pdfplumber finds the two tables too but
  truncates cells and pulls in pdfminer.six + pypdfium2 (binary wheel) — not needed.

## Header (label → value pairs, Russian labels, in this order)
```
ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "АЛЬФА-БАНК"  + address/phone lines
Выписка по операциям, совершенным по банковскому счету <account type name>, <HOLDER>
Клиент <HOLDER>
Документ, удостоверяющий личность <passport data>        ← PII, must never be stored
Адрес регистрации <address>                              ← PII, must never be stored
Счёт BY..ALFA..                                          ← IBAN (28 chars)
Валюта счёта BYN
Тип счёта <name>
Дата открытия dd.mm.yyyy
Процентная ставка, текущая d.ddd%
Период dd.mm.yyyy - dd.mm.yyyy
Дата и время формирования выписки dd.mm.yyyy, hh:mm
Доступный остаток <amount> BYN
Кредитный лимит <amount> BYN
Неснижаемый остаток <amount> BYN
Баланс на начало периода <amount> BYN        (label wraps: "Баланс на начало" / "периода <amount> BYN")
Баланс на конец периода <amount> BYN
Приход <amount> BYN
Расход -<amount> BYN                          (negative sign on the expense total)
Привязанные карты <card product>(d***********dddd), …
Выписка за период dd.mm.yyyy - dd.mm.yyyy
```
So the statement DOES carry opening balance, closing balance AND the two totals
(income, expense). The brief's "if the header lacks a balance" arm is not needed for
Alfa; the check set is: `opening + Σrows == closing`, `Σincome rows == Приход`,
`Σexpense rows == Расход` (sign-aware), and every row date inside `Период`.
There is NO per-row running balance column (unlike Credo).

## Operations table
Header (wrapped in the PDF, joined by pypdf as 4 columns):
`Дата | Примечание | Сумма в валюте счета | Сумма в валюте операции`

One extracted line per operation:
`dd.mm.yyyy <description…> <signed amount> <CCY> <signed original amount> <CCY>`

Description shapes seen:
- card purchase: `<8 digits> <CITY> Покупка товара / получение услуг <MERCHANT>` —
  the 8-digit token is an auth/reference number, city free text (`Minsk`, `MINSK`,
  `G. MINSK`, `g MINSK`, `ALMATY`, `ONLINE SERVICE`), merchant = tail after
  `Покупка товара / получение услуг `, may contain quotes, dots, hyphens, spaces.
- ERIP payment: `<8 digits> ONLINE SERVICE InSync (ERIP)`.
- credit: `Зачисление <free text…>` (salary line is LONG, contains several
  dd.mm.yyyy dates and `№` numbers INSIDE the description — a date-trap);
  `Зачисление перевода <name> dd.mm.yyyy`; `Зачисление бонусов (подарок) соглас но
  условиям программы лояльности "Альфа-Бонус"` (note the broken word "соглас но"
  — extraction artefact, keep verbatim).
- outgoing transfer: `Перевод средств на помощь ребенку <name>` (word split
  artefacts like `М ария` appear — keep verbatim).

Number formats: decimal POINT, trailing zeros dropped (`-99.9`, `9`, `9999.9`),
minus sign prefix for expenses, currency code after the number. Original amount
differs for FX operations (example shape: `-NN.NN BYN -NNN RUB`). Row dates have
no time. Header repeats the column titles on page 2; rows continue in order.

## Implications recorded for the design
1. Anchors for validation (currency, period, opening, closing, income total,
   expense total) are stable label/value pairs → parse them DETERMINISTICALLY
   (regex over the joined text); the LLM extracts ROWS. Validation then compares
   LLM rows against deterministic anchors — two independent sources.
2. The extracted text contains PII (holder, passport, address, IBAN). Only the
   operation lines + the anchor values go to the LLM; the PII block is cut
   before the prompt and NEVER stored (raw JSON of a row = its own line only).
3. Amount parsing is the server's: the LLM returns the amount as it reads it
   (string, major units) and the server converts via `domain/money` at the
   statement currency exponent; the LLM never does arithmetic.
