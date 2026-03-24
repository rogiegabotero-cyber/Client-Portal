// src/api/userScheduleApi.js
export default class UserScheduleAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://us-central1-hyacinthattendance.cloudfunctions.net";
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
}