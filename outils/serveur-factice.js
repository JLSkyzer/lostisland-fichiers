// Serveur factice qui imite l'API des fichiers du jeu (docs/api-logiciel-fichiers.md du site), sur un
// dossier local. Sert aux essais automatiques (test/essai.js) et au mode d'essai de l'application
// (LI_ESSAI=1, jamais dans l'application installée). N'écoute que sur 127.0.0.1.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const NOM_SUR = /^[^\\/:*?"<>|\u0000-\u001f]+$/;
const ID_ENVOI = /^[a-z0-9]{8,40}$/;

class Refus extends Error {
  constructor(statut, message) {
    super(message);
    this.statut = statut;
  }
}

function demarrer({ racine, comptes = { essai: "essai" }, lenteur = 0, port = 0 } = {}) {
  fs.mkdirSync(racine, { recursive: true });
  const envois = path.join(racine, ".envois");
  const stats = { morceaux: [], requetes: 0 };
  // Pour les essais : un morceau dont la requête est coupée en cours de route (simulation de coupure).
  const pannes = { couperMorceau: null };

  function cheminSur(rel) {
    const segments = String(rel ?? "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    for (const s of segments) if (!NOM_SUR.test(s) || s === "." || s === ".." || s.startsWith(".") || s.length > 150) throw new Refus(400, `Nom refusé : « ${s} ».`);
    return { abs: path.join(racine, ...segments), segments };
  }

  async function lister(abs, base) {
    const r = [];
    for (const e of await fs.promises.readdir(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) r.push(...(await lister(p, base)));
      else r.push(path.relative(base, p).split(path.sep).join("/"));
    }
    return r;
  }

  async function sha1(f) {
    const h = crypto.createHash("sha1");
    await pipeline(fs.createReadStream(f), h);
    return h.digest("hex");
  }

  const json = (res, statut, corps) => {
    res.writeHead(statut, { "Content-Type": "application/json" });
    res.end(JSON.stringify(corps));
  };

  async function lireCorps(req) {
    const m = [];
    for await (const x of req) m.push(x);
    return Buffer.concat(m);
  }

  // Corps reçu, ralenti au besoin (lenteur en ms par 64 Kio) pour voir la progression dans l'interface.
  async function ecrireCorps(req, dest) {
    const sortie = fs.createWriteStream(dest);
    for await (const m of req) {
      if (lenteur) await new Promise((ok) => setTimeout(ok, (lenteur * m.length) / 65536));
      if (!sortie.write(m)) await new Promise((ok) => sortie.once("drain", ok));
    }
    await new Promise((ok, ko) => sortie.end((e) => (e ? ko(e) : ok())));
  }

  async function traiter(req, res) {
    stats.requetes++;
    const u = new URL(req.url, "http://x");
    const route = u.pathname.replace(/^\/api\/fichiers\/?/, "");
    const auth = req.headers.authorization ?? "";
    const brut = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
    const i = brut.indexOf(":");
    if (i < 1 || comptes[brut.slice(0, i)] !== brut.slice(i + 1)) throw new Refus(401, "Nom ou mot de passe incorrect.");
    const p = u.searchParams;

    if (route === "liste" && req.method === "GET") {
      const { abs } = cheminSur(p.get("chemin"));
      const chemin = (p.get("chemin") ?? "").replace(/^\/+|\/+$/g, "");
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        throw new Refus(404, "Ce dossier n'existe pas (ou plus).");
      }
      if (!st.isDirectory()) throw new Refus(404, "Ce dossier n'existe pas (ou plus).");
      if (p.get("recursif") === "1") {
        const fichiers = await Promise.all(
          (await lister(abs, abs)).map(async (sous) => {
            const f = path.join(abs, ...sous.split("/"));
            const s = await fs.promises.stat(f);
            return { chemin: sous, taille: s.size, sha1: await sha1(f), modifie: s.mtime.toISOString() };
          }),
        );
        return json(res, 200, { chemin, fichiers });
      }
      const entrees = [];
      for (const e of await fs.promises.readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const s = await fs.promises.stat(path.join(abs, e.name));
        const dossier = e.isDirectory();
        entrees.push({ nom: e.name, dossier, taille: dossier ? null : s.size, fichiers: dossier ? (await lister(path.join(abs, e.name), abs)).length : 0, modifie: s.mtime.toISOString() });
      }
      return json(res, 200, { chemin, entrees });
    }

    if (route === "fichier" && req.method === "GET") {
      const { abs } = cheminSur(p.get("chemin"));
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        throw new Refus(404, "Ce fichier n'existe pas (ou plus).");
      }
      if (!st.isFile()) throw new Refus(404, "Ce fichier n'existe pas (ou plus).");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size });
      return pipeline(fs.createReadStream(abs), res);
    }

    if (route === "fichier" && req.method === "PUT") {
      const { abs, segments } = cheminSur(p.get("chemin"));
      if (!segments.length) throw new Refus(400, "Nom de fichier manquant.");
      const envoi = p.get("envoi");
      if (!envoi) {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        const tmp = path.join(path.dirname(abs), `.envoi-${Date.now()}-${path.basename(abs)}`);
        await ecrireCorps(req, tmp);
        await fs.promises.rename(tmp, abs);
        return json(res, 200, { ok: true, fini: true });
      }
      const morceau = Number(p.get("morceau"));
      const morceaux = Number(p.get("morceaux"));
      if (!ID_ENVOI.test(envoi)) throw new Refus(400, "Identifiant d'envoi invalide.");
      if (!Number.isInteger(morceaux) || morceaux < 1 || morceaux > 2000 || !Number.isInteger(morceau) || morceau < 0 || morceau >= morceaux) throw new Refus(400, "Numéro de morceau invalide.");
      const longueur = Number(req.headers["content-length"]);
      stats.morceaux.push({ envoi, morceau, morceaux, longueur });
      const dossier = path.join(envois, envoi);
      await fs.promises.mkdir(dossier, { recursive: true });
      if (pannes.couperMorceau === morceau) {
        pannes.couperMorceau = null;
        req.socket.destroy(); // coupure en plein envoi
        return;
      }
      await ecrireCorps(req, path.join(dossier, `${morceau}.part`));
      await fs.promises.rename(path.join(dossier, `${morceau}.part`), path.join(dossier, String(morceau)));
      if (morceau < morceaux - 1) return json(res, 200, { ok: true, fini: false });
      for (let k = 0; k < morceaux; k++) {
        if (!fs.existsSync(path.join(dossier, String(k)))) throw new Refus(409, `Le morceau ${k + 1} sur ${morceaux} manque : renvoyez le fichier.`);
      }
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      const tmp = path.join(path.dirname(abs), `.envoi-${envoi}`);
      const sortie = fs.createWriteStream(tmp);
      for (let k = 0; k < morceaux; k++) await pipeline(fs.createReadStream(path.join(dossier, String(k))), sortie, { end: false });
      await new Promise((ok, ko) => sortie.end((e) => (e ? ko(e) : ok())));
      await fs.promises.rename(tmp, abs);
      await fs.promises.rm(dossier, { recursive: true, force: true });
      return json(res, 200, { ok: true, fini: true });
    }

    if (route === "fichier" && req.method === "DELETE") {
      const { abs, segments } = cheminSur(p.get("chemin"));
      if (!segments.length) throw new Refus(400, "Impossible de supprimer la racine.");
      await fs.promises.rm(abs, { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }

    if (route === "operation" && req.method === "GET") {
      const envoi = p.get("envoi") ?? "";
      if (!ID_ENVOI.test(envoi)) throw new Refus(400, "Identifiant d'envoi invalide.");
      let recus = [];
      try {
        recus = (await fs.promises.readdir(path.join(envois, envoi))).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
      } catch {}
      return json(res, 200, { recus });
    }

    if (route === "operation" && req.method === "POST") {
      const b = JSON.parse((await lireCorps(req)).toString("utf8") || "{}");
      if (b.action === "dossier") {
        await fs.promises.mkdir(cheminSur(b.chemin).abs, { recursive: true });
      } else if (b.action === "renommer") {
        const de = cheminSur(b.de);
        const vers = cheminSur(b.vers);
        if (!de.segments.length || !vers.segments.length) throw new Refus(400, "Impossible de renommer la racine.");
        if (!fs.existsSync(de.abs)) throw new Refus(404, "Ce fichier n'existe pas (ou plus).");
        await fs.promises.mkdir(path.dirname(vers.abs), { recursive: true });
        await fs.promises.rename(de.abs, vers.abs);
      } else throw new Refus(400, "Action inconnue.");
      return json(res, 200, { ok: true });
    }
    throw new Refus(404, "Route inconnue.");
  }

  const serveur = http.createServer((req, res) => {
    traiter(req, res).catch((e) => {
      if (res.headersSent || res.destroyed) return;
      json(res, e instanceof Refus ? e.statut : 500, { erreur: e instanceof Refus ? e.message : "Erreur interne, réessayez dans un instant." });
    });
  });
  return new Promise((ok) =>
    serveur.listen(port, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${serveur.address().port}/api/fichiers`;
      ok({ base, stats, pannes, fermer: () => new Promise((f) => (serveur.closeAllConnections?.(), serveur.close(f))) });
    }),
  );
}

module.exports = { demarrer };
