importScripts("/worker-actions.js");
self.onconnect = (ev) => {
  const port = ev.ports[0];
  port.onmessage = async (msg) => {
    const result = await workerAction(msg.data);
    port.postMessage(Object.assign({ id: msg.data.id }, result));
  };
  port.start();
  port.postMessage({ ready: true, sendToString: Function.prototype.toString.call(WebSocket.prototype.send) });
};
