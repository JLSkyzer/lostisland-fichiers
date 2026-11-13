// Client de l'API des fichiers du jeu (contrat : docs/api-logiciel-fichiers.md du site).
// Sans Electron : il tourne aussi dans les essais Node (test/essai.js), contre un serveur factice local.
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const contrat = require("./contrat");

class ErreurApi extends Error {
  constructor(message, { statut = null, code = null } = {}) {
    super(message);
    this.name = "ErreurApi";
    this.statut = statut;
    if (code) this.code = code;
  }
}

// Toute erreur, ramenée à un message clair en français (le code d'origine est gardé pour les nouveaux essais).
function traduire(e) {
  if (e instanceof ErreurApi || e?.name === "AbortError") return e;
  const m = contrat.messageSysteme(e);
  if (m) return new ErreurApi(m, { code: e.code });
  return new ErreurApi(e?.message || "Erreur inattendue.", { code: e?.code });
}

const attendre = (ms, signal) =>
  new Promise((ok, ko) => {
    if (signal?.aborted) return ko(abandon());
    const t = setTimeout(ok, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), ko(abandon())), { once: true });
  });
function abandon() {
  const e = new Error("Transfert annulé.");
  e.name = "AbortError";
  return e;
}

class Client {
  /**
   * base : https://lostisland.eriniumlab.com/api/fichiers
   * essais : nombre de tentatives par requête de transfert (1 + 3 nouveaux essais)
   * seuil, tailleMorceau : ceux du contrat ; modifiables pour les seuls essais automatiques.
   */
  constructor({ base, nom, motDePasse, agentUtilisateur = "LostIslandFichiers", essais = 4, delaiEssai = 1500, seuil = contrat.SEUIL_MORCEAUX, tailleMorceau = contrat.TAILLE_MORCEAU, reprises = null }) {
    this.base = new URL(base.replace(/\/+$/, "") + "/");
    this.nom = nom;
    this.auth = "Basic " + Buffer.from(`${nom}:${motDePasse}`, "utf8").toString("base64");
    this.agentUtilisateur = agentUtilisateur;
    this.essais = essais;
    this.delaiEssai = delaiEssai;
    this.seuil = seuil;
    this.tailleMorceau = tailleMorceau;
    this.reprises = reprises;
    const Agent = this.base.protocol === "https:" ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 6 });
  }

  fermer() {
    this.agent.destroy();
  }

  url(route, query = {}) {
    const u = new URL(route, this.base);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    return u;
  }

  /* Requête brute : renvoie { statut, entetes, res } une fois les en-têtes de réponse reçus.
     corps : null, Buffer, ou { flux: () => Readable, longueur }. */
  brute(methode, route, { query, corps = null, entetes = {}, signal, delai = 120_000 } = {}) {
    const u = this.url(route, query);
    const mod = u.protocol === "https:" ? https : http;
    return new Promise((ok, ko) => {
      const h = { Authorization: this.auth, "User-Agent": this.agentUtilisateur, Accept: "application/json, application/octet-stream", ...entetes };
      if (Buffer.isBuffer(corps)) h["Content-Length"] = corps.length;
      else if (corps) {
        h["Content-Length"] = corps.longueur;
        h["Content-Type"] = "application/octet-stream";
      }
      const req = mod.request(u, { method: methode, headers: h, agent: this.agent, signal });
      req.setTimeout(delai, () => {
        const e = new Error("Délai dépassé.");
        e.code = "ETIMEDOUT";
        req.destroy(e);
      });
      req.on("error", ko);
      req.on("response", (res) => ok({ statut: res.statusCode, entetes: res.headers, res }));
      if (Buffer.isBuffer(corps)) req.end(corps);
      else if (corps) {
        const flux = corps.flux();
        flux.on("error", (e) => req.destroy(e));
        flux.pipe(req);
      } else req.end();
    });
  }

  // Lit une réponse JSON ; une réponse d'erreur devient une ErreurApi avec le message du site.
  async json(methode, route, options = {}) {
    let r;
    try {
      r = await this.brute(methode, route, options);
    } catch (e) {
      throw traduire(e);
    }
    const morceaux = [];
    try {
      for await (const m of r.res) morceaux.push(m);
    } catch (e) {
      throw traduire(e);
    }
    const texte = Buffer.concat(morceaux).toString("utf8");
    let donnees = null;
    try {
      donnees = texte ? JSON.parse(texte) : null;
    } catch {
      /* page HTML de Cloudflare, par exemple */
    }
    if (r.statut >= 400) throw new ErreurApi(contrat.messageHttp(r.statut, donnees?.erreur), { statut: r.statut });
    if (donnees == null) throw new ErreurApi(`Réponse inattendue du site (${r.statut}).`, { statut: r.statut });
    return donnees;
  }

  // Une requête de transfert, retentée en cas de coupure ou d'indisponibilité passagère.
  async avecEssais(faire, signal) {
    for (let essai = 1; ; essai++) {
      try {
        return await faire(essai);
      } catch (e) {
        const t = traduire(e);
        if (signal?.aborted) throw abandon();
        if (essai >= this.essais || !contrat.aRetenter(t)) throw t;
        await attendre(this.delaiEssai * essai, signal);
      }
    }
  }

  /* Routes du contrat. */

  liste(chemin = "") {
    return this.json("GET", "liste", { query: { chemin: contrat.normaliser(chemin) }, delai: 30_000 });
  }
  listeRecursive(chemin = "") {
    return this.json("GET", "liste", { query: { chemin: contrat.normaliser(chemin), recursif: 1 }, delai: 300_000 });
  }
  recus(envoi) {
    return this.json("GET", "operation", { query: { envoi }, delai: 30_000 });
  }
  operation(corps) {
    return this.json("POST", "operation", { corps: Buffer.from(JSON.stringify(corps)), entetes: { "Content-Type": "application/json" }, delai: 60_000 });
  }
  creerDossier(chemin) {
    return this.operation({ action: "dossier", chemin: contrat.normaliser(chemin) });
  }
  renommer(de, vers) {
    return this.operation({ action: "renommer", de: contrat.normaliser(de), vers: contrat.normaliser(vers) });
  }
  supprimer(chemin) {
    const c = contrat.normaliser(chemin);
    if (!c) throw new ErreurApi("Impossible de supprimer la racine.");
    return this.json("DELETE", "fichier", { query: { chemin: c }, delai: 120_000 });
  }

  /* Envoi d'un fichier local vers cheminDistant. Au-delà du seuil : morceaux, reprise, nouveaux essais.
     surOctets(n) reçoit les octets envoyés (négatif quand une tentative échouée est annulée). */
  async envoyer(local, cheminDistant, { signal, surOctets = () => {}, surEtape = () => {} } = {}) {
    const distant = contrat.normaliser(cheminDistant);
    const st = await fs.promises.stat(local).catch((e) => {
      throw traduire(e);
    });
    const plan = contrat.planMorceaux(st.size, this.seuil, this.tailleMorceau);
    if (!plan) {
      await this.avecEssais(() => this.envoyerTranche(local, { chemin: distant }, 0, st.size, signal, surOctets), signal);
      return { morceaux: 0, renvoyes: 0 };
    }

    // Gros fichier : identifiant d'envoi gardé sur disque, pour reprendre plus tard ce qui manque.
    const cle = contrat.cleReprise(distant, st.size, st.mtimeMs);
    let id = this.reprises?.trouver(cle);
    let recus = [];
    if (id) {
      try {
        recus = (await this.recus(id)).recus ?? [];
      } catch (e) {
        if (e.statut === 400) id = null; // identifiant que le serveur ne reconnaît pas : nouvel envoi
        else throw e;
      }
    }
    if (!id) {
      id = contrat.nouvelIdEnvoi();
      this.reprises?.garder(cle, id);
    }

    const n = plan.length;
    let deja = 0;
    for (const i of recus) if (i < n - 1 && plan[i]) deja += plan[i].fin - plan[i].debut;
    if (deja) surOctets(deja);
    let ordre = contrat.morceauxAEnvoyer(n, recus);
    const renvoyes = ordre.length;

    for (let tour = 0; ; tour++) {
      for (const i of ordre) {
        const m = plan[i];
        surEtape({ morceau: i, morceaux: n });
        const query = { chemin: distant, envoi: id, morceau: i, morceaux: n };
        try {
          await this.avecEssais(() => this.envoyerTranche(local, query, m.debut, m.fin, signal, surOctets), signal);
        } catch (e) {
          // 409 : le serveur dit qu'il manque un morceau au moment d'assembler ; on redemande la liste, une fois.
          if (e.statut === 409 && i === n - 1 && tour === 0) {
            surOctets(-(m.fin - m.debut));
            break;
          }
          throw e;
        }
        if (i === n - 1) {
          this.reprises?.oublier(cle);
          return { morceaux: n, renvoyes };
        }
      }
      const r = (await this.recus(id)).recus ?? [];
      ordre = contrat.morceauxAEnvoyer(n, r);
      for (const i of ordre.slice(0, -1)) surOctets(-(plan[i].fin - plan[i].debut));
    }
  }

  async envoyerTranche(local, query, debut, fin, signal, surOctets) {
    const longueur = fin - debut;
    let envoyes = 0;
    const flux = () => {
      const lecture = longueur ? fs.createReadStream(local, { start: debut, end: fin - 1 }) : require("node:stream").Readable.from([]);
      const compteur = new Transform({
        transform(m, _e, suite) {
          envoyes += m.length;
          surOctets(m.length);
          suite(null, m);
        },
      });
      lecture.on("error", (e) => compteur.destroy(e));
      return lecture.pipe(compteur);
    };
    try {
      return await this.json("PUT", "fichier", { query, corps: { flux, longueur }, signal, delai: 180_000 });
    } catch (e) {
      surOctets(-envoyes);
      throw e;
    }
  }

  /* Téléchargement de cheminDistant vers le fichier local, par un fichier temporaire « .lipart » renommé
     une fois complet : un fichier à moitié reçu ne remplace jamais l'ancien. */
  async telecharger(cheminDistant, local, { signal, surOctets = () => {} } = {}) {
    await fs.promises.mkdir(path.dirname(local), { recursive: true }).catch((e) => {
      throw traduire(e);
    });
    const tmp = `${local}.lipart`;
    return this.avecEssais(async () => {
      let recus = 0;
      try {
        const r = await this.brute("GET", "fichier", { query: { chemin: contrat.normaliser(cheminDistant) }, signal, delai: 120_000 });
        if (r.statut >= 400) {
          const morceaux = [];
          for await (const m of r.res) morceaux.push(m);
          let erreur = null;
          try {
            erreur = JSON.parse(Buffer.concat(morceaux).toString("utf8")).erreur;
          } catch {}
          throw new ErreurApi(contrat.messageHttp(r.statut, erreur), { statut: r.statut });
        }
        const attendu = Number(r.entetes["content-length"]);
        const compteur = new Transform({
          transform(m, _e, suite) {
            recus += m.length;
            surOctets(m.length);
            suite(null, m);
          },
        });
        await pipeline(r.res, compteur, fs.createWriteStream(tmp), { signal });
        if (Number.isFinite(attendu) && recus !== attendu) throw Object.assign(new Error("Téléchargement incomplet."), { code: "ECONNRESET" });
        await fs.promises.rename(tmp, local);
        return { octets: recus };
      } catch (e) {
        surOctets(-recus);
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    }, signal);
  }
}

module.exports = { Client, ErreurApi, traduire, abandon };
