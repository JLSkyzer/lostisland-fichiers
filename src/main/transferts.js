// File des transferts : deux tâches à la fois au plus, chacune faite d'opérations (envoyer, télécharger,
// créer un dossier, supprimer). Une tâche = un fichier, un dossier entier ou une synchronisation.
// Sans Electron : l'interface reçoit l'état par l'évènement « maj » (src/main/main.js le lui transmet).
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const contrat = require("./contrat");
const { traduire } = require("./api");

const PARALLELES = 2;
const TERMINES = new Set(["fini", "erreur", "annule"]);

class FileTransferts extends EventEmitter {
  constructor(client, { paralleles = PARALLELES, intervalle = 150 } = {}) {
    super();
    this.client = client;
    this.paralleles = paralleles;
    this.intervalle = intervalle;
    this.taches = [];
    this.suivant = 1;
    this.minuterie = null;
  }

  /* sens : "envoi" | "telechargement" | "sync" ; preparer(signal) renvoie la liste des opérations :
     { type: "envoi", local, distant, taille } | { type: "telechargement", distant, local, taille }
     { type: "dossier", distant } | { type: "dossierLocal", local } | { type: "supprimer", distant } */
  ajouter({ sens, titre, detail = "", preparer, cible = null }) {
    const t = {
      id: this.suivant++,
      sens,
      titre,
      detail,
      cible, // { cote: "local" | "distant", chemin } : volet à rafraîchir à la fin
      etat: "attente",
      total: 0,
      fait: 0,
      vitesse: 0,
      operations: 0,
      faites: 0,
      courant: "",
      erreur: null,
      echecs: [],
      ajoute: Date.now(),
      _preparer: preparer,
      _controle: new AbortController(),
      _points: [],
    };
    this.taches.push(t);
    this.signaler(true);
    this.lancerSuivantes();
    return t.id;
  }

  annuler(id) {
    const t = this.taches.find((x) => x.id === id);
    if (!t || TERMINES.has(t.etat)) return false;
    t._controle.abort();
    if (t.etat === "attente") {
      t.etat = "annule";
      this.signaler(true);
    }
    return true;
  }

  annulerTout() {
    for (const t of this.taches) this.annuler(t.id);
  }

  effacerTermines() {
    this.taches = this.taches.filter((t) => !TERMINES.has(t.etat));
    this.signaler(true);
  }

  enCours() {
    return this.taches.some((t) => !TERMINES.has(t.etat));
  }

  liste() {
    return this.taches.map(({ _preparer, _controle, _points, ...pub }) => ({ ...pub, echecs: pub.echecs.slice(0, 20) }));
  }

  // Envoi de l'état à l'interface : immédiat pour un changement d'état, sinon au plus tous les 150 ms.
  signaler(immediat = false) {
    if (immediat) {
      clearTimeout(this.minuterie);
      this.minuterie = null;
      this.emit("maj", this.liste());
      return;
    }
    if (this.minuterie) return;
    this.minuterie = setTimeout(() => {
      this.minuterie = null;
      this.emit("maj", this.liste());
    }, this.intervalle);
  }

  lancerSuivantes() {
    const actives = this.taches.filter((t) => t.etat === "preparation" || t.etat === "encours").length;
    let libres = this.paralleles - actives;
    for (const t of this.taches) {
      if (libres <= 0) break;
      if (t.etat !== "attente") continue;
      libres--;
      this.executer(t).finally(() => {
        this.signaler(true);
        this.emit("fini", { id: t.id, etat: t.etat, cible: t.cible });
        this.lancerSuivantes();
      });
    }
  }

  async executer(t) {
    const signal = t._controle.signal;
    t.etat = "preparation";
    t.debut = Date.now();
    this.signaler(true);
    let ops;
    try {
      ops = await t._preparer(signal);
    } catch (e) {
      return this.terminer(t, e);
    }
    if (signal.aborted) return this.terminer(t, { name: "AbortError" });
    t.operations = ops.length;
    t.total = ops.reduce((s, o) => s + (o.taille ?? 0), 0);
    t.etat = "encours";
    this.signaler(true);

    const surOctets = (n) => {
      t.fait = Math.max(0, Math.min(t.total, t.fait + n));
      const maintenant = Date.now();
      t._points.push({ t: maintenant, octets: t.fait });
      while (t._points.length > 2 && maintenant - t._points[0].t > 4000) t._points.shift();
      t.vitesse = contrat.vitesse(t._points, maintenant);
      this.signaler();
    };

    for (const op of ops) {
      if (signal.aborted) return this.terminer(t, { name: "AbortError" });
      t.courant = op.distant ?? op.local ?? "";
      this.signaler();
      try {
        await this.operation(op, signal, surOctets);
      } catch (e0) {
        const e = traduire(e0);
        if (e.name === "AbortError" || signal.aborted) return this.terminer(t, { name: "AbortError" });
        // Identifiants refusés, site injoignable : inutile d'essayer les fichiers suivants.
        if (e.statut === 401 || contrat.aRetenter(e)) return this.terminer(t, e);
        t.echecs.push({ chemin: t.courant, erreur: e.message });
      }
      t.faites++;
    }
    return this.terminer(t, t.echecs.length ? new Error(t.echecs.length === 1 ? `${t.echecs[0].chemin} : ${t.echecs[0].erreur}` : `${t.echecs.length} éléments en échec, dont ${t.echecs[0].chemin} : ${t.echecs[0].erreur}`) : null);
  }

  async operation(op, signal, surOctets) {
    const c = this.client;
    switch (op.type) {
      case "envoi":
        return c.envoyer(op.local, op.distant, { signal, surOctets });
      case "telechargement":
        return c.telecharger(op.distant, op.local, { signal, surOctets });
      case "dossier":
        return c.creerDossier(op.distant);
      case "dossierLocal":
        return fs.promises.mkdir(op.local, { recursive: true });
      case "supprimer":
        return c.supprimer(op.distant);
      default:
        throw new Error(`Opération inconnue : ${op.type}`);
    }
  }

  terminer(t, e) {
    t.fin = Date.now();
    t.vitesse = 0;
    t.courant = "";
    if (!e) t.etat = "fini";
    else if (e.name === "AbortError" || t._controle.signal.aborted) t.etat = "annule";
    else {
      t.etat = "erreur";
      t.erreur = traduire(e).message;
    }
  }
}

module.exports = { FileTransferts, PARALLELES };
