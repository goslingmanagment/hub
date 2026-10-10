importScripts("/worker-actions.js");
self.onmessage = async (ev) => {
  const result = await workerAction(ev.data);
  self.postMessage(Object.assign({ id: ev.data.id }, result));
};
self.postMessage({ ready: true, sendToString: Function.prototype.toString.call(WebSocket.prototype.send) });
