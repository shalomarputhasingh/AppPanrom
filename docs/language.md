# AppPanrom language reference (v1)

This is the canonical definition of the language. The parser (`backend/apppanrom/lang`), validator, runtime
(`runtime/apppanrom-runtime.js`), editor highlighting, Studio reference panel and Android generator all derive from
this grammar and from [`spec/schema.json`](../spec/schema.json). Anything not listed here is **not supported**.

AppPanrom is Tanglish: familiar English programming words mixed with everyday spoken Tamil, written in lowercase
`snake_case` Roman letters. Source is **never** run as Python or JavaScript: it is parsed to an AST, validated, lowered
to a JSON IR, and walked by a controlled interpreter.

## 1. File structure and entry point

A project's entry file is `main.apn` (UTF-8, at most 200 000 bytes). Top level may contain only:

1. App settings: `app_uruvakku`, `app_id_set`, `app_version_set`, `app_theme_set`, `app_start_screen`.
2. Global variables: `mari name = expression`.
3. Function definitions.
4. Screen declarations: `screen_uruvakku("name"): <block>`.

The app starts on `app_start_screen(...)`, or on the first declared screen. Global variable initialisers run once at
app start, in order. At least one screen is required.

```
app_uruvakku("Vanakkam App")
app_id_set("com.apppanrom.vanakkam")
app_version_set("1.0.0")

mari clicks = 0

function welcome():
    clicks = clicks + 1
    message_kaattu("Vanakkam!")

screen_uruvakku("home"):
    screen_title("Vanakkam")
    column_uruvakku(style={"padding": 24, "gap": 16}):
        title("Vanakkam Nanba!")
        button("Click Pannu", click_pannumbodhu=welcome)
```

App settings are validated: application id `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (max 100 chars, no Java
keywords), version `MAJOR.MINOR.PATCH` (each 0-999), theme `light` or `dark`. Values in `main.apn` override the
project settings made in the Studio; the Studio values are the defaults. **All** of these go into the APK.

## 2. Lexical rules

* Indentation is **4 spaces per level**. Tabs and other widths are errors. A block follows a line ending in `:`.
* `#` starts a comment. Blank and comment-only lines are ignored.
* Newlines inside `(...)`, `[...]`, `{...}` are ignored, so long calls may span lines.
* Strings use straight `"` or `'` quotes with escapes `\n \t \" \' \\`. Curly quotes are rejected with a hint.
* Numbers: `42`, `3.14`. Literals: `true`, `false`, `null`.
* Keywords: `mari function return enna_na illana_enna illana ovvoru in irukkura_varai try catch and or not summa true false null`.

## 3. Values, variables, operators

Types: number, text, bool, list, dictionary (text keys), null. There is **no implicit coercion**: `"a" + 1` is an
error (use `str(1)`); `1 < "a"` is an error.

* `mari count = 0` declares a variable (once per scope); `count = count + 1` assigns. `items[0] = x`, `d["k"] = x` assign into collections.
* **Scope.** Global variables are the app's state. Inside a function, `mari` creates a function-local variable
  (shadowing a global if named the same); assigning to an undeclared-locally name changes the global. Function
  parameters are local. Loop variables and `catch` names are local to the enclosing function/screen.
* Precedence (high to low): unary `-`; `* / %`; `+ -`; comparison `== != < > <= >=` (not chainable); `not`; `and`; `or`.
* `+` works on number+number, text+text, list+list. `and`/`or` short-circuit and yield true/false.
* Truthiness (for `enna_na`, `irukkura_varai`, `not`, `and`, `or`): `false`, `null`, `0`, `""`, `[]`, `{}` are false.
* Indexing: `list[i]` (0-based, out of range is an error), `text[i]`, `dict["key"]` (missing key is an error; use `dict_get`).
* `==` compares collections deeply.

## 4. Control flow, functions, errors

```
enna_na count > 10:            # if
    ...
illana_enna count > 5:         # else if (any number)
    ...
illana:                        # else
    ...

ovvoru item in items:          # for-each over list, text characters or dict keys
    ...
ovvoru i in range(5):          # repeat 5 times: i = 0..4

irukkura_varai count < 5:      # while
    count = count + 1

function greet(name):          # defined at top level only; recursion limited to depth 100
    return "Vanakkam " + name

try:
    data_save_pannu("name", "Shalom")
catch error:                   # `error` is the message text
    error_kaattu(error)
```

`summa` ("nothing") is a statement that does nothing. It makes an empty block legal, e.g. an empty container you will fill in
later, or a handler you haven't written yet. The visual designer uses it for empty containers.

There is no `break`/`continue`. A `try` catches runtime errors but **not** resource-limit errors.

## 5. Screens, components, layout

A screen is a block of component statements. Components may be nested inside containers, and `enna_na` / `ovvoru`
may be used inside screens and containers to build UI conditionally or from lists. **A screen is re-drawn after every
event** (button, input change, navigation); drawing must be pure: it may read variables and call pure functions, but it
may not assign globals or call functions that change state (`message_kaattu`, `toast_kaattu`, `input_set`, `clipboard_copy`, `vibrate_pannu`, `data_save_pannu`,
`data_delete_pannu`, `data_clear_pannu`, `screen_ku_poo`, `screen_back_poo`, `screen_data_set`). Change state in event handlers.

`screen_title(text)` sets the app-bar title (default: the app name). `screen_uruvakku("name", style={...})` accepts a screen style.

| Component | Kind | Signature | Events |
|---|---|---|---|
| `title` | leaf | `title(text, style={})` | - |
| `text_kaattu` | leaf | `text_kaattu(text, style={})` | - |
| `button` | leaf | `button(label, click_pannumbodhu=handler, enabled=true, style={})` | click_pannumbodhu |
| `input_uruvakku` | leaf | `input_uruvakku(name, label="", placeholder="", initial="", change_aagumbodhu=handler, submit_pannumbodhu=handler)` | change_aagumbodhu, submit_pannumbodhu |
| `password_input` | leaf | `password_input(name, label="", placeholder="")` | change_aagumbodhu, submit_pannumbodhu |
| `number_input` | leaf | `number_input(name, label="", placeholder="", initial=0)` | change_aagumbodhu, submit_pannumbodhu |
| `checkbox_uruvakku` | leaf | `checkbox_uruvakku(name, label="", initial=false)` | change_aagumbodhu |
| `toggle_uruvakku` | leaf | `toggle_uruvakku(name, label="", initial=false)` | change_aagumbodhu |
| `dropdown_uruvakku` | leaf | `dropdown_uruvakku(name, options=["a", "b"], label="", initial="a")` | change_aagumbodhu |
| `image_kaattu` | leaf | `image_kaattu(src, alt="")` | - |
| `list_kaattu` | leaf | `list_kaattu(items)` | - |
| `progress_kaattu` | leaf | `progress_kaattu(value, label="")` | - |
| `loading_kaattu` | leaf | `loading_kaattu(label="")` | - |
| `divider_kaattu` | leaf | `divider_kaattu()` | - |
| `card_uruvakku` | container (block) | `card_uruvakku(style={}): <block>` | - |
| `column_uruvakku` | container (block) | `column_uruvakku(style={}): <block>` | - |
| `row_uruvakku` | container (block) | `row_uruvakku(style={}): <block>` | - |
| `center_ama` | container (block) | `center_ama(style={}): <block>` | - |

* Required first arguments are positional; everything else is `name=value`. Unknown options are errors.
* **Events** take the *name* of a zero-parameter function: `click_pannumbodhu=welcome` (no quotes, no parentheses).
  Handlers run when the user acts; errors inside them are logged with line/column and never crash the app.
  `change_aagumbodhu` fires on every edit (checkbox/toggle/dropdown: on change). `submit_pannumbodhu` fires on Enter.
* **Inputs.** The first argument is a fixed text name. `input_value(name)` reads it (text; number for `number_input` or
  `null` when empty; bool for checkbox/toggle). `input_set(name, value)` changes it without firing events. Input names are
  app-wide. Values are kept across redraws and across screens during one run. Setting `initial` only affects the first draw.
* Text typed by the user is rendered with `textContent`; HTML in user data is never interpreted.
* `image_kaattu` accepts only `https://` URLs and `data:image/` URIs. The generated Android app requests the
  `INTERNET` permission only if the program uses `image_kaattu`.
* Accessibility: inputs render a real `<label>`, images take `alt`, buttons use their label, toggles use `role="switch"`,
  progress and loading expose ARIA roles, and messages use `role="alertdialog"`.

### Navigation

`screen_ku_poo("name")` pushes a screen (the name must exist; literal names are checked at compile time),
`screen_back_poo()` pops (no-op on the first screen). The Android back button and the app-bar arrow do the same.
`screen_data_set(key, value)` / `screen_data_get(key, default)` pass values between screens (in memory, per run).

## 6. Styling

Styles are a small validated schema, not CSS. A style is attached to one component (or screen) with `style={...}` and
applies **only to that component and, for text properties, its descendants** (text colour, size, weight and alignment
inherit; nothing else does). Styling one button never changes another. Invalid keys or values are compile errors for
literals, and for dynamic values the offending key is ignored with a console warning.

| Group | Keys |
|---|---|
| box | `background`, `padding`, `margin`, `width`, `height`, `corner_radius`, `border_width`, `border_color`, `opacity`, `visible` |
| text | `text_color`, `font_size`, `font_weight`, `text_align` |
| color | `text_color` (progress bar fill) |
| flow | `gap`, `align`, `justify`, `wrap`, `scroll` |

| Key | Value |
|---|---|
| `background` | hex color `#RGB` / `#RRGGBB` |
| `text_color` | hex color `#RGB` / `#RRGGBB` |
| `border_color` | hex color `#RGB` / `#RRGGBB` |
| `padding` | number 0-200 |
| `margin` | number 0-200 |
| `gap` | number 0-200 |
| `corner_radius` | number 0-200 |
| `border_width` | number 0-20 |
| `font_size` | number 8-96 |
| `opacity` | number 0-1 |
| `width` | number, `"NN%"` or `"fill"` |
| `height` | number, `"NN%"` or `"fill"` |
| `font_weight` | `normal` \| `medium` \| `bold` |
| `text_align` | `left` \| `center` \| `right` |
| `align` | `start` \| `center` \| `end` \| `stretch` |
| `justify` | `start` \| `center` \| `end` \| `space_between` \| `space_around` |
| `wrap` | `true` / `false` |
| `scroll` | `true` / `false` |
| `visible` | `true` / `false` |

Layout notes: containers stack children vertically (`column_uruvakku`, the default for `card_uruvakku`), horizontally
(`row_uruvakku`) or centre them on both axes (`center_ama`). `align` is the cross axis (default `stretch`; rows
default to `center`), `justify` the main axis (default `start`). `scroll` controls overflow (screens scroll vertically by
default). `background` on a button sets its colour; on a screen, the screen colour. Colours accept only `#RGB` / `#RRGGBB`.
`app_theme_set("light" | "dark")` switches the default palette; explicit style colours always win.

**Not supported yet** (compile error): `gradient`, `shadow`, `font_family`, `text_decor`, `line_height`, the other named
themes. Responsive behaviour comes only from flex layout and percentage widths (no breakpoints).

## 7. Standard library

All functions validate their arguments and raise a runtime error with a useful message (catchable with `try`).
Aliases are intentionally avoided: there is one name per operation.

| Signature | Description |
|---|---|
| `message_kaattu(value)` | modal message with OK |
| `toast_kaattu(value)` | short transient message |
| `debug_log(value)` | console debug line |
| `warning_kaattu(value)` | console warning |
| `error_kaattu(value)` | console error |
| `int(value)` | number or numeric text to integer |
| `float(value)` | number or numeric text to number |
| `str(value)` | text form of any value |
| `bool(value)` | truthiness |
| `type_of(value)` | "number" | "text" | "bool" | "list" | "dict" | "null" |
| `text_length(text)` |  |
| `text_upper(text)` |  |
| `text_lower(text)` |  |
| `text_trim(text)` |  |
| `text_replace(text, old, new)` |  |
| `text_split(text, separator)` |  |
| `text_join(items, separator)` |  |
| `text_contains(text, part)` |  |
| `length(list_or_dict)` |  |
| `append(list, value)` | adds in place |
| `remove(list, index)` | removes in place, returns removed value |
| `sort(list)` | new sorted list (all numbers or all text) |
| `range(stop) or range(start, stop)` |  |
| `dict_get(dict, key, default=null)` |  |
| `dict_keys(dict)` |  |
| `min(list) or min(a, b)` |  |
| `max(list) or max(a, b)` |  |
| `sum(list_of_numbers)` |  |
| `round(value, digits=0)` |  |
| `abs(value)` |  |
| `json_encode(value) -> text` |  |
| `json_decode(text) -> value (raises error on bad JSON)` |  |
| `now_iso()` | current UTC time, ISO 8601 text |
| `random_number(low, high)` | random integer, both ends included (not cryptographically secure) |
| `random_choice(list)` | random item (not cryptographically secure) |
| `input_value(name)` | current value of an input component |
| `input_set(name, value)` | set an input component's value |
| `data_save_pannu(key, value)` | persist JSON-compatible value (app-local, not encrypted) |
| `data_edu(key, default=null)` | read persisted value |
| `data_delete_pannu(key)` |  |
| `data_clear_pannu()` | remove all of this app's persisted data |
| `screen_ku_poo(name)` | navigate to a screen |
| `screen_back_poo()` | go back (no-op on the first screen) |
| `screen_data_set(key, value)` | shared in-memory data for screen-to-screen passing |
| `clipboard_copy(text)` | copy text to the clipboard (needs a user tap; no Android permission required). In the preview it needs a browser that allows it, otherwise a console warning is logged |
| `vibrate_pannu(milliseconds)` | vibrate the phone, 1-5000 ms. Declares the `VIBRATE` permission. The preview only vibrates on devices that support it (otherwise a warning is logged) |
| `screen_data_get(key, default=null)` |  |

## 8. Android permissions

The compiler works out which Android permissions your program needs and the APK declares **exactly those** (also shown in the Studio's
Build tab). Both are *install-time* ("normal") permissions: no runtime prompt appears.

| Feature used | Permission | Why |
|---|---|---|
| `image_kaattu` | `INTERNET` | images are loaded from the internet |
| `vibrate_pannu` | `VIBRATE` | making the phone vibrate |

Permissions that need a runtime prompt (camera, location, notifications...) are **not implemented**. Nothing is requested "just in case".

## 9. Local data storage

`data_save_pannu` / `data_edu` / `data_delete_pannu` / `data_clear_pannu` store JSON-compatible values per app.
In the Studio preview the data lives in your browser, keyed by project; in an APK it lives in the app's private WebView
storage. A project's data is never visible to another project's runtime. Limits: key ≤ 100 chars, value ≤ 100 000
characters, ≤ 1 000 000 characters per app; exceeding them raises an error. **This is not a secure vault** and is not
encrypted. Do not store passwords or tokens.

## 10. Runtime limits and security model

* Source is untrusted. It is parsed with a fixed grammar and run by an interpreter with a function allow-list;
  there is no `eval`, `exec`, import, file, process or network access from AppPanrom code.
* Limits per entry point (startup, event, or screen draw): 1 000 000 interpreter steps (endless loops stop with an
  error), 100 nested calls, lists ≤ 100 000 items, text ≤ 1 000 000 characters, log lines ≤ 2 000 characters.
  These resource errors cannot be caught by `try`.
* The Studio preview runs in a sandboxed iframe (`allow-scripts` only, no same-origin access, restrictive CSP).
* The Android app serves its files from the APK over a virtual https origin with `file://` access disabled, a restrictive
  CSP, and **no JavaScript-to-native bridge**.
* Random functions use `Math.random` and are **not** cryptographically secure.

## 11. Supported vs. unsupported

Implemented and tested: everything in this document. **Not implemented** (the compiler says so if you use them):
`api_get, api_post, api_put, api_delete, api_json, dialog_kaattu, app_icon_set, app_config, state_uruvakku, state_get, state_set, ui_refresh, screen_refresh, vadivelu_mode, enna_kodumai_debug, summa_adirudhulla, gradient_set, shadow_set`. Network APIs and runtime-permission device capabilities (camera, location, notifications...)
are future work. The app icon, release signing and AAB output are handled by the Studio / build pipeline, not by language functions. The optional "fun mode" is not implemented.

## 12. Common errors

| Message | Cause / fix |
|---|---|
| `Unknown function 'text_kaatu'. Did you mean 'text_kaattu'?` | Typo; suggestions come from the built-in list. |
| `Variable 'x' is not declared.` | Declare it with `mari x = ...` first. |
| `'text_kaattu' draws UI and can only be used inside a screen block.` | Use `message_kaattu(...)` / `toast_kaattu(...)` inside functions. |
| `Cannot use '+' between text and number. Use str(...)` | No implicit coercion: `"n=" + str(n)`. |
| `Handler 'x' must take no parameters.` | Event handlers are called with no arguments. |
| `Screens cannot change global 'n' while drawing` | Move the assignment into an event-handler function. |
| `Indentation must be a multiple of 4 spaces` | Use 4 spaces per level, no tabs. |

## 13. AST and IR (for tool authors)

`parse()` produces plain-dict nodes with `t` (type) and `pos: [line, col]`. Statements: `let`, `assign`, `if`, `for`,
`while`, `return`, `try`, `function`, `call_stmt`, `block_call`. Expressions: `num str bool null name list dict bin un
index call`. `compile_source()` validates and lowers to the IR consumed by every renderer:

```
{"ir_version": 1,
 "app": {"name","id","version","theme","start_screen"},
 "style_schema": {...from spec...},
 "globals": [let...], "functions": {name: {"params", "body", "pos"}},
 "screens": {name: {"style", "body", "pos"}}, "screen_order": [...]}
```

UI statements are lowered to `{"t":"comp","c":name,"props":{...exprs},"events":{event: function_name},"style":dict_expr|null,"children":[...]}`
and `screen_title(...)` to `{"t":"screen_title","e":expr}`. The runtime evaluates the expressions on every draw and
builds a *view tree* of plain objects; the DOM renderer only consumes that view tree.
