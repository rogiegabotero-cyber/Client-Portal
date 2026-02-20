# Client Portal

This project is a React + Vite client portal UI.

## Hyacinth Attendance API integration

The app now supports loading employee attendance data from the Hyacinth Attendance API.

### Environment variables

Create a `.env` file with:

```bash
VITE_HYACINTH_API_KEY=hk_your_api_key_here
VITE_HYACINTH_DEPARTMENT_ID=dept_123
```

If either variable is missing, the app falls back to the existing local dummy data.

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
