export default class HyacinthAttendanceAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl =
      import.meta.env.VITE_HYACINTH_BASE_URL ||
      "https://us-central1-hyacinthattendance.cloudfunctions.net";
  }

  async #post(path, body, signal) {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ apiKey: this.apiKey, ...body }),
      signal,
    });

    const result = await response.json();

    if (!result?.success) {
      throw new Error(result?.message || `Request failed: ${path}`);
    }

    return result.data;
  }

  getUsersByDepartment(departmentId, signal) {
    return this.#post("getUsersByDepartment", { departmentId }, signal);
  }

  getUserSchedule(userId, signal) {
    return this.#post("getUserSchedule", { userId }, signal);
  }

  getAttendanceLogs(options = {}, signal) {
    const { userId, startDate, endDate } = options;
    return this.#post("getAttendanceLogs", { userId, startDate, endDate }, signal);
  }
}