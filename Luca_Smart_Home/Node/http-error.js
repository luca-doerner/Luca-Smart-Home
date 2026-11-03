// error with the HTTP status the API answers with, e.g. new HttpError(404, "Gerät nicht gefunden")
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Status für „ein Dienst hinter uns (Bring!, YAZIO) hat versagt“. Nicht 502: vor dem Pi steht
// Cloudflare, und das ersetzt ein 502 vom Server durch seine eigene „Bad gateway“-Seite — die
// Meldung dazu ginge verloren, und die Seite zeigte nur „Bad Gateway“. 424 (Failed Dependency)
// kommt unverändert durch.
HttpError.UPSTREAM = 424;

module.exports = HttpError;
