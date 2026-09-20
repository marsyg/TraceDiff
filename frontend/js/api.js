"use strict";
/* frontend-v2/js/api.js — live AWS backend integration.
   Zero mock diff data: every divergence, metric, and summary rendered
   downstream comes from these calls. Any failure surfaces raw backend
   response as a toast; nothing is faked. */

function apiError(method, url, res, bodyText) {
  return method + " " + url + " -> HTTP " + res.status + " " + res.statusText + "\n" + bodyText;
}
function presign(filename) {
  var url = BASE_URL + "/presign?filename=" + encodeURIComponent(filename) + "&contentType=application/json";
  return fetch(url).then(function (res) {
    return res.text().then(function (t) {
      if (!res.ok) throw new Error(apiError("GET", url, res, t));
      var data;
      try { data = JSON.parse(t); } catch (e) { throw new Error("GET " + url + " -> invalid JSON:\n" + t); }
      if (!data.uploadUrl || !data.key) throw new Error("GET " + url + " -> missing uploadUrl/key:\n" + t);
      return data;
    });
  });
}
function putToS3(uploadUrl, text) {
  return fetch(uploadUrl, { method: "PUT", body: text, headers: { "Content-Type": "application/json" } }).then(function (res) {
    if (!res.ok) return res.text().then(function (t) { throw new Error(apiError("PUT", "<s3-presigned-url>", res, t)); });
  });
}
function readTolerance() {
  var v = parseFloat(el("tolerance-input").value);
  if (isNaN(v) || v < 0) return 0.05;
  return v > 1 ? v / 100 : v;
}
function readIgnoreFields() {
  return el("ignore-fields-input").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}
function submitJob(traceAKey, traceBKey) {
  var url = BASE_URL + "/jobs";
  var rules = Object.keys(state.rules).filter(function (r) { return state.rules[r]; });
  var body = JSON.stringify({
    traceAKey: traceAKey, traceBKey: traceBKey, rules: rules,
    config: { tolerance: readTolerance(), ignoreFields: readIgnoreFields() }
  });
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body }).then(function (res) {
    return res.text().then(function (t) {
      if (!res.ok && res.status !== 202) throw new Error(apiError("POST", url, res, t));
      var data;
      try { data = JSON.parse(t); } catch (e) { throw new Error("POST " + url + " -> invalid JSON:\n" + t); }
      if (!data.jobId) throw new Error("POST " + url + " -> missing jobId:\n" + t);
      return data;
    });
  });
}
function getJob(jobId) {
  var url = BASE_URL + "/jobs/" + jobId;
  return fetch(url).then(function (res) {
    return res.text().then(function (t) {
      if (!res.ok) throw new Error(apiError("GET", url, res, t));
      try { return JSON.parse(t); } catch (e) { throw new Error("GET " + url + " -> invalid JSON:\n" + t); }
    });
  });
}
function getResults(jobId) {
  var all = [];
  function page(token) {
    var url = BASE_URL + "/jobs/" + jobId + "/results?limit=200" + (token ? "&nextToken=" + encodeURIComponent(token) : "");
    return fetch(url).then(function (res) {
      return res.text().then(function (t) {
        if (!res.ok) throw new Error(apiError("GET", url, res, t));
        var data;
        try { data = JSON.parse(t); } catch (e) { throw new Error("GET " + url + " -> invalid JSON:\n" + t); }
        all = all.concat(data.results || []);
        if (data.nextToken) return page(data.nextToken);
        return all;
      });
    });
  }
  return page(null);
}
