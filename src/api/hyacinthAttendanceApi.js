// src/api/hyacinthAttendanceApi.js
export default class HyacinthAttendanceAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://us-central1-hyacinthattendance.cloudfunctions.net";
  }

  async getUsersByDepartment(departmentId) {
    const response = await fetch(`${this.baseUrl}/getUsersByDepartment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ apiKey: this.apiKey, departmentId }),
    });

    const result = await response.json();
    if (!result.success) throw new Error(result.message);
    return result.data;
  }

  async getUserSchedule(userId) {
    const response = await fetch(`${this.baseUrl}/getUserSchedule`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ apiKey: this.apiKey, userId }),
    });

    const result = await response.json();
    if (!result.success) throw new Error(result.message);
    return result.data;
  }

  // ✅ FROM DOCS
  async getAttendanceLogs(options = {}) {
    const { userId, startDate, endDate } = options;

    const response = await fetch(`${this.baseUrl}/getAttendanceLogs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ apiKey: this.apiKey, userId, startDate, endDate }),
    });

    const result = await response.json();
    if (!result.success) throw new Error(result.message);
    return result.data;
  }
}