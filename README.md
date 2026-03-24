# Client Portal

This project is a React + Vite client portal UI.

## Setup after cloning

1. Clone and open the project:

```bash
git clone https://github.com/rogiegabotero-cyber/Client-Portal.git
cd logistcs-portal
```

2. Install dependencies:

```bash
npm install
```

3. Create your local environment file:

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

4. Open `.env` and set the values for your environment.

5. Run the app:

```bash
npm run dev
```

Notes:

- Keep `.env` local only. Do not commit it.
- `VITE_` variables are bundled into frontend code, so do not place private server secrets in them.
- `VITE_HYACINTH_API_KEY` and `VITE_HYACINTH_DEPARTMENT_ID` are required to load employee attendance data.
- If `VITE_INVOICES_EMBED_URL` is omitted, the app will use its built-in default invoices URL.

### Implemented API endpoints

- `POST /getUsersByDepartment`
- `POST /getUserSchedule`
- `POST /getAttendanceLogs`

Implemented in `src/api/hyacinthAttendanceApi.js`.

The client also includes:

- retry with exponential backoff for retryable HTTP statuses (`429`, `500`, `502`, `503`, `504`)
- consistent error objects with `status` and optional `debug` metadata
- automatic unwrapping of Firebase callable responses that return `{ data: ... }`

### Callable functions support

The same API client includes wrappers for documented callable functions (`generateApiKey`, `listApiKeys`, `deleteApiKey`, `changeUserPassword`, `changeUserEmail`, `testFunction`, `testAuth`) via an injected `callableInvoker` function.
