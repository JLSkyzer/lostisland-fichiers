// Interface de Lost Island Fichiers. Aucun accès direct au disque ni au réseau : tout passe par window.li
// (src/preload.js). Les noms de fichiers sont toujours écrits par textContent, jamais interprétés comme HTML.
"use strict";

const $ = (id) => document.getElementById(id);
// `li` : les fonctions exposées par src/preload.js (window.li).

/* Petits outils */

function el(balise, attributs = {}, ...enfants) {
  const e = document.createElement(balise);
  for (const [k, v] of Object.entries(attributs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "texte") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const x of enfants.flat()) if (x != null && x !== false) e.append(x instanceof Node ? x : String(x));
  return e;
}
function icone(nom) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#i-${nom}`);
  s.append(u);
  s.setAttribute("aria-hidden", "true");
  return s;
}

const UNITES = ["o", "Ko", "Mo", "Go", "To"];
function taille(n) {
  if (n == null) return "";
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITES.length - 1) {
    v /= 1024;
    i++;
  }
  const chiffres = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toLocaleString("fr-FR", { maximumFractionDigits: chiffres, minimumFractionDigits: chiffres })} ${UNITES[i]}`;
}
const formatDate = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const date = (iso) => (iso ? formatDate.format(new Date(iso)).replace(",", "") : "");
const pluriel = (n, un, plusieurs = un + "s") => `${n.toLocaleString("fr-FR")} ${n > 1 ? plusieurs : un}`;
const comparerNoms = new Intl.Collator("fr", { numeric: true, sensitivity: "base" }).compare;

function annoncer(texte, { erreur = false, duree = erreur ? 7000 : 3500 } = {}) {
  const a = el("div", { class: `annonce${erreur ? " erreur-annonce" : ""}`, role: erreur ? "alert" : "status", texte });
  $("annonces").append(a);
  setTimeout(() => a.remove(), duree);
}

/* Dialogue unique, réutilisé (élément <dialog> natif : focus gardé dedans, Échap pour fermer). */

const dlg = $("dialogue");
let resoudreCourant = null;
let dialogueFermable = true;

// Ouvre le dialogue (ou remplace son contenu s'il est déjà ouvert : le précédent se résout à null).
function dialogue({ titre, corps = [], actions = [], large = false, fermable = true }) {
  return new Promise((resoudre) => {
    resoudreCourant?.(null);
    resoudreCourant = resoudre;
    majDialogue({ titre, corps, actions, large, fermable });
    if (!dlg.open) dlg.showModal();
    const defaut = dlg.querySelector("[data-defaut]") ?? dlg.querySelector("input, .dialogue-actions button");
    defaut?.focus();
  });
}
function majDialogue({ titre, corps = [], actions = [], large = false, fermable = true }) {
  dialogueFermable = fermable;
  dlg.classList.toggle("large", large);
  $("dialogue-titre").textContent = titre;
  $("dialogue-corps").replaceChildren(...[corps].flat().filter(Boolean).map((x) => (typeof x === "string" ? el("p", { texte: x }) : x)));
  $("dialogue-actions").replaceChildren(
    ...actions.map((a) =>
      el("button", {
        type: a.soumettre ? "submit" : "button",
        class: `btn ${a.style ?? ""}`,
        "data-defaut": a.defaut || null,
        disabled: a.desactive || null,
        texte: a.texte,
        onclick: (ev) => {
          ev.preventDefault();
          if (a.agir) a.agir();
          else fermerDialogue(a.valeur ?? null);
        },
      }),
    ),
  );
}
function fermerDialogue(v = null) {
  const r = resoudreCourant;
  resoudreCourant = null;
  if (dlg.open) dlg.close();
  r?.(v);
}
dlg.addEventListener("cancel", (e) => {
  e.preventDefault();
  if (dialogueFermable) fermerDialogue(null);
});
// Entrée valide l'action marquée par défaut (sauf dans une liste ou sur un bouton, qui gèrent la leur).
dlg.querySelector("form").addEventListener("submit", (e) => {
  e.preventDefault();
  dlg.querySelector(".dialogue-actions [data-defaut]")?.click();
});

const confirmer = (titre, corps, { oui = "Confirmer", style = "principal", non = "Annuler", defautNon = false } = {}) =>
  dialogue({
    titre,
    corps,
    actions: [
      { texte: non, valeur: false, defaut: defautNon },
      { texte: oui, valeur: true, style, defaut: !defautNon },
    ],
  }).then((v) => v === true);

// Demande un nom ; verifier(nom) renvoie un message d'erreur ou null.
function demanderNom({ titre, aide, valeur = "", oui, verifier = () => null }) {
  const champ = el("input", { class: "saisie", value: valeur, spellcheck: "false", "aria-label": "Nom" });
  const err = el("p", { class: "erreur", role: "alert", hidden: true });
  const p = dialogue({
    titre,
    corps: [aide ? el("p", { texte: aide }) : null, champ, err],
    actions: [
      { texte: "Annuler", valeur: null },
      {
        texte: oui,
        style: "principal",
        defaut: true,
        agir: () => {
          const v = champ.value.trim();
          const m = verifier(v);
          if (m) {
            err.textContent = m;
            err.hidden = false;
            champ.focus();
            return;
          }
          fermerDialogue(v);
        },
      },
    ],
  });
  champ.focus();
  // Sélectionne le nom sans son extension, comme l'explorateur.
  const point = valeur.lastIndexOf(".");
  champ.setSelectionRange(0, point > 0 ? point : valeur.length);
  return p;
}

// Même règle que le serveur (src/main/contrat.js : refusNom).
function refusNom(nom) {
  if (!nom) return "Le nom est vide.";
  if (nom.startsWith(".")) return "Un nom ne peut pas commencer par un point : le serveur refuse les fichiers cachés.";
  if (nom.length > 150) return "Nom trop long (150 caractères au plus).";
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(nom)) return 'Ces caractères sont interdits dans un nom : \\ / : * ? " < > |';
  return null;
}

/* Volets : même mécanique pour le PC et le serveur, avec un adaptateur par côté. */

const COTES = {
  local: {
    async lister(chemin) {
      const r = await li.localLister(chemin);
      if (!r.ok) throw new Error(r.erreur);
      return { chemin: r.dossier, parent: r.parent, entrees: r.entrees, separateur: r.separateur };
    },
    joindre(v, nom) {
      const s = v.separateur;
      return v.chemin.endsWith(s) ? v.chemin + nom : v.chemin + s + nom;
    },
    // Fil d'Ariane : C:\Users\nom → C:\ › Users › nom ; /home/nom → / › home › nom.
    segments(v) {
      const s = v.separateur;
      const parties = v.chemin.split(s).filter(Boolean);
      const debut = v.chemin.startsWith(s) ? s : "";
      const r = [];
      let acc = debut;
      parties.forEach((p, i) => {
        acc = i === 0 ? debut + p + (debut ? "" : s) : (acc.endsWith(s) ? acc : acc + s) + p;
        r.push({ nom: i === 0 && !debut ? p + s : p, chemin: acc });
      });
      if (debut) r.unshift({ nom: s, chemin: s });
      return r;
    },
  },
  distant: {
    async lister(chemin) {
      const r = await li.distantLister(chemin);
      if (!r.ok) throw Object.assign(new Error(r.erreur), { statut: r.statut });
      const parts = r.chemin.split("/").filter(Boolean);
      return { chemin: r.chemin, parent: parts.length ? parts.slice(0, -1).join("/") : null, entrees: r.entrees };
    },
    joindre: (v, nom) => (v.chemin ? `${v.chemin}/${nom}` : nom),
    segments(v) {
      const parts = v.chemin.split("/").filter(Boolean);
      return [{ nom: "racine (.lostisland)", chemin: "", racine: true }, ...parts.map((p, i) => ({ nom: p, chemin: parts.slice(0, i + 1).join("/") }))];
    },
  },
};

class Volet {
  constructor(cote) {
    this.cote = cote;
    this.a = COTES[cote];
    this.racine = document.getElementById(`volet-${cote}`);
    this.liste = this.racine.querySelector(".liste");
    this.corps = this.racine.querySelector("tbody");
    this.message = this.racine.querySelector(".liste-message");
    this.chemin = null;
    this.parent = null;
    this.separateur = "/";
    this.entrees = [];
    this.vue = [];
    this.tri = { cle: "nom", sens: 1 };
    this.selection = new Set();
    this.ancre = 0;
    this.courant = 0;
    this.lignes = [];
    this.jeton = 0;
    this.brancher();
  }

  get autre() {
    return this.cote === "local" ? volets.distant : volets.local;
  }

  async aller(chemin, { garderSelection = false, choisir = null } = {}) {
    const jeton = ++this.jeton;
    this.liste.classList.add("chargement");
    try {
      const r = await this.a.lister(chemin);
      if (jeton !== this.jeton) return;
      const memeDossier = r.chemin === this.chemin;
      Object.assign(this, { chemin: r.chemin, parent: r.parent, entrees: r.entrees, separateur: r.separateur ?? "/" });
      this.erreur = null;
      if (!garderSelection || !memeDossier) {
        this.selection.clear();
        this.courant = 0;
        this.ancre = 0;
      } else {
        const noms = new Set(r.entrees.map((e) => e.nom));
        for (const n of this.selection) if (!noms.has(n)) this.selection.delete(n);
      }
      this.trier();
      if (choisir) {
        const i = this.vue.findIndex((e) => e.nom === choisir);
        if (i >= 0) {
          this.courant = this.ancre = i;
          this.selection = new Set([choisir]);
        }
      }
      this.rendre();
    } catch (e) {
      if (jeton !== this.jeton) return;
      if (e.statut === 404 && this.cote === "distant" && chemin) {
        annoncer(`Le dossier /${chemin} n'existe plus sur le serveur.`, { erreur: true });
        return this.aller(chemin.split("/").slice(0, -1).join("/"));
      }
      this.erreur = e.message;
      if (this.chemin == null) this.chemin = chemin;
      this.entrees = [];
      this.trier();
      this.rendre();
    } finally {
      if (jeton === this.jeton) this.liste.classList.remove("chargement");
    }
  }

  actualiser() {
    return this.aller(this.chemin, { garderSelection: true });
  }

  monter() {
    if (this.parent == null) return;
    const quitte = this.cote === "local" ? this.chemin.split(this.separateur).filter(Boolean).pop() : this.chemin.split("/").pop();
    return this.aller(this.parent, { choisir: quitte });
  }

  trier() {
    const { cle, sens } = this.tri;
    this.vue = [...this.entrees].sort((a, b) => {
      if (a.dossier !== b.dossier) return a.dossier ? -1 : 1; // dossiers d'abord, quel que soit le sens
      let d = 0;
      if (cle === "taille") d = (a.dossier ? a.fichiers ?? 0 : a.taille ?? 0) - (b.dossier ? b.fichiers ?? 0 : b.taille ?? 0);
      else if (cle === "modifie") d = String(a.modifie).localeCompare(String(b.modifie));
      return (d || comparerNoms(a.nom, b.nom)) * sens;
    });
  }

  /* Affichage */

  rendre() {
    // Fil d'Ariane
    const ariane = this.racine.querySelector(".ariane");
    const segs = this.chemin != null ? this.a.segments(this) : [];
    ariane.replaceChildren(
      ...segs.flatMap((s, i) => [
        i ? el("span", { class: "chevron", "aria-hidden": "true", texte: "›" }) : null,
        el("button", { class: s.racine ? "racine" : null, title: s.chemin || "Racine des fichiers du jeu (l'intérieur de .lostisland chez les joueurs)", texte: s.nom, "aria-current": i === segs.length - 1 ? "location" : null, onclick: () => this.aller(s.chemin) }),
      ]).filter(Boolean),
    );
    ariane.scrollLeft = ariane.scrollWidth;

    // En-têtes de tri
    for (const th of this.racine.querySelectorAll("th[data-tri]")) {
      if (th.dataset.tri === this.tri.cle) th.setAttribute("aria-sort", this.tri.sens > 0 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }

    // Lignes
    const lignes = [];
    if (this.parent != null && !this.erreur) {
      lignes.push(
        el("tr", { class: "parent dossier", title: "Dossier parent", ondblclick: () => this.monter() },
          el("td", { class: "c-nom" }, el("span", { class: "nom" }, icone("parent"), el("span", { texte: ".." }))),
          el("td", { class: "c-taille" }),
          el("td", { class: "c-date" }),
        ),
      );
    }
    this.lignes = this.vue.map((e, i) => {
      const estOptionnel = this.cote === "distant" && e.dossier && e.nom === "optionalmod" && !this.chemin;
      const tr = el(
        "tr",
        {
          class: [e.dossier ? "dossier" : "", e.ignore ? "ignore" : ""].filter(Boolean).join(" ") || null,
          "data-i": i,
          draggable: "true",
          "aria-selected": "false",
          title: e.ignore ? `${e.nom} : jamais envoyé (fichier caché ou système)` : e.nom,
        },
        el("td", { class: "c-nom" }, el("span", { class: "nom" }, icone(e.dossier ? "dossier" : /\.jar$/i.test(e.nom) ? "jar" : "fichier"), el("span", { texte: e.nom }), estOptionnel ? el("span", { class: "etiquette", texte: "mods optionnels" }) : null)),
        el("td", { class: "c-taille", texte: e.dossier ? (this.cote === "distant" ? pluriel(e.fichiers ?? 0, "fichier") : "") : taille(e.taille) }),
        el("td", { class: "c-date", texte: date(e.modifie) }),
      );
      return tr;
    });
    this.corps.replaceChildren(...lignes, ...this.lignes);

    this.message.hidden = !(this.erreur || !this.vue.length);
    this.message.classList.toggle("erreur-liste", !!this.erreur);
    this.message.textContent = this.erreur ? this.erreur : this.cote === "distant" ? "Dossier vide. Glissez-y des fichiers pour les envoyer." : "Dossier vide.";
    this.majSelection();
    if (this.cote === "distant") majRappel();
  }

  majSelection() {
    this.courant = Math.min(this.courant, Math.max(0, this.vue.length - 1));
    this.lignes.forEach((tr, i) => {
      const s = this.selection.has(this.vue[i].nom);
      tr.classList.toggle("sel", s);
      tr.setAttribute("aria-selected", s ? "true" : "false");
      tr.classList.toggle("courant", i === this.courant);
    });
    const sel = this.selectionnes();
    const octets = sel.reduce((s, e) => s + (e.taille ?? 0), 0);
    const dossiers = this.vue.filter((e) => e.dossier).length;
    const total = `${pluriel(dossiers, "dossier")}, ${pluriel(this.vue.length - dossiers, "fichier")}`;
    this.racine.querySelector(".compteur").textContent = this.erreur ? "" : sel.length ? `${pluriel(sel.length, "élément sélectionné", "éléments sélectionnés")}${octets ? ` · ${taille(octets)}` : ""} · ${total}` : total;
    majBoutons();
  }

  montrerCourant() {
    this.lignes[this.courant]?.scrollIntoView({ block: "nearest" });
  }

  selectionnes() {
    return this.vue.filter((e) => this.selection.has(e.nom));
  }

  cheminDe(e) {
    return this.a.joindre(this, e.nom);
  }

  selectionner(i, { ctrl = false, maj = false } = {}) {
    if (i < 0 || i >= this.vue.length) return;
    if (maj) {
      const [a, b] = [Math.min(this.ancre, i), Math.max(this.ancre, i)];
      if (!ctrl) this.selection.clear();
      for (let k = a; k <= b; k++) this.selection.add(this.vue[k].nom);
    } else if (ctrl) {
      const n = this.vue[i].nom;
      if (this.selection.has(n)) this.selection.delete(n);
      else this.selection.add(n);
      this.ancre = i;
    } else {
      this.selection = new Set([this.vue[i].nom]);
      this.ancre = i;
    }
    this.courant = i;
    this.majSelection();
    this.montrerCourant();
  }

  ouvrir(e) {
    if (e.dossier) return this.aller(this.cheminDe(e));
    // Un fichier : double-clic = le transférer de l'autre côté, comme dans WinSCP.
    transferer(this, [e]);
  }

  /* Évènements */

  brancher() {
    this.racine.addEventListener("pointerdown", () => activer(this.cote), true);
    this.liste.addEventListener("focus", () => activer(this.cote));

    this.racine.querySelector("thead").addEventListener("click", (ev) => {
      const th = ev.target.closest("th[data-tri]");
      if (!th) return;
      const cle = th.dataset.tri;
      this.tri = { cle, sens: this.tri.cle === cle ? -this.tri.sens : cle === "nom" ? 1 : -1 };
      const courant = this.vue[this.courant]?.nom;
      this.trier();
      this.courant = Math.max(0, this.vue.findIndex((e) => e.nom === courant));
      this.rendre();
    });

    this.corps.addEventListener("mousedown", (ev) => {
      const tr = ev.target.closest("tr[data-i]");
      if (!tr) {
        if (!ev.target.closest("tr")) {
          this.selection.clear();
          this.majSelection();
        }
        return;
      }
      const i = Number(tr.dataset.i);
      // Clic sur un élément déjà sélectionné : on garde la sélection (pour la glisser).
      if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && this.selection.has(this.vue[i].nom)) {
        this.courant = i;
        this.majSelection();
        return;
      }
      this.selectionner(i, { ctrl: ev.ctrlKey || ev.metaKey, maj: ev.shiftKey });
    });
    this.corps.addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr[data-i]");
      if (!tr || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      const i = Number(tr.dataset.i);
      if (this.selection.size > 1 && this.selection.has(this.vue[i].nom)) this.selectionner(i);
    });
    this.liste.addEventListener("mousedown", (ev) => {
      if (ev.target === this.liste || ev.target.classList.contains("liste-message")) {
        this.selection.clear();
        this.majSelection();
      }
    });
    this.corps.addEventListener("dblclick", (ev) => {
      const tr = ev.target.closest("tr[data-i]");
      if (tr) this.ouvrir(this.vue[Number(tr.dataset.i)]);
    });

    this.liste.addEventListener("keydown", (ev) => this.clavier(ev));

    // Glisser depuis ce volet
    this.corps.addEventListener("dragstart", (ev) => {
      const tr = ev.target.closest("tr[data-i]");
      if (!tr) return ev.preventDefault();
      const i = Number(tr.dataset.i);
      if (!this.selection.has(this.vue[i].nom)) this.selectionner(i);
      glisse = { cote: this.cote, elements: this.selectionnes() };
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("application/x-lostisland", this.cote);
      const n = glisse.elements.length;
      const etiquette = el("div", { class: "annonce", texte: n === 1 ? glisse.elements[0].nom : pluriel(n, "élément") });
      etiquette.style.position = "fixed";
      etiquette.style.top = "-100px";
      document.body.append(etiquette);
      ev.dataTransfer.setDragImage(etiquette, -12, -8);
      setTimeout(() => etiquette.remove(), 0);
    });
    this.corps.addEventListener("dragend", () => {
      glisse = null;
      finDepot();
    });

    // Déposer dans ce volet : depuis l'autre volet, ou (côté serveur) depuis l'explorateur du système.
    this.liste.addEventListener("dragover", (ev) => {
      const accepte = (glisse && glisse.cote !== this.cote) || (!glisse && this.cote === "distant" && ev.dataTransfer.types.includes("Files"));
      if (!accepte) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      const tr = ev.target.closest("tr[data-i]");
      const surDossier = tr && this.vue[Number(tr.dataset.i)]?.dossier ? tr : null;
      marquerDepot(this, surDossier);
    });
    this.liste.addEventListener("dragleave", (ev) => {
      if (!this.liste.contains(ev.relatedTarget)) finDepot();
    });
    this.liste.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      const tr = ev.target.closest("tr[data-i]");
      const dossierCible = tr && this.vue[Number(tr.dataset.i)]?.dossier ? this.cheminDe(this.vue[Number(tr.dataset.i)]) : null;
      finDepot();
      if (glisse && glisse.cote !== this.cote) {
        const g = glisse;
        glisse = null;
        return transferer(this.autre, g.elements, dossierCible);
      }
      if (!glisse && this.cote === "distant" && ev.dataTransfer.files.length) {
        const chemins = [...ev.dataTransfer.files].map((f) => li.cheminDe(f)).filter(Boolean);
        if (!chemins.length) return;
        const r = await li.localInfos(chemins);
        if (!r.ok || !r.elements.length) return annoncer("Ces éléments ne peuvent pas être lus.", { erreur: true });
        envoyerChemins(r.elements, dossierCible);
      }
    });
  }

  clavier(ev) {
    const n = this.vue.length;
    const ctrl = ev.ctrlKey || ev.metaKey;
    const aller = (i) => {
      ev.preventDefault();
      if (!n) return;
      i = Math.max(0, Math.min(n - 1, i));
      if (ev.shiftKey) this.selectionner(i, { maj: true, ctrl });
      else if (ctrl) {
        this.courant = i;
        this.majSelection();
        this.montrerCourant();
      } else this.selectionner(i);
    };
    const parPage = Math.max(1, Math.floor(this.liste.clientHeight / 25) - 2);
    switch (ev.key) {
      case "ArrowDown":
        return aller(this.selection.size || ctrl ? this.courant + 1 : this.courant);
      case "ArrowUp":
        return aller(this.courant - 1);
      case "PageDown":
        return aller(this.courant + parPage);
      case "PageUp":
        return aller(this.courant - parPage);
      case "Home":
        return aller(0);
      case "End":
        return aller(n - 1);
      case " ":
        ev.preventDefault();
        if (n) this.selectionner(this.courant, { ctrl: true });
        return;
      case "Enter":
        ev.preventDefault();
        if (this.vue[this.courant]) this.ouvrir(this.vue[this.courant]);
        return;
      case "Backspace":
        ev.preventDefault();
        return this.monter();
      case "Escape":
        if (this.selection.size) {
          ev.preventDefault();
          this.selection.clear();
          this.majSelection();
        }
        return;
      case "a":
      case "A":
        if (!ctrl) return;
        ev.preventDefault();
        this.selection = new Set(this.vue.map((e) => e.nom));
        return this.majSelection();
    }
    if (ev.key.length === 1 && !ctrl && !ev.altKey) {
      // Saut à l'élément dont le nom commence par la lettre tapée.
      const l = ev.key.toLowerCase();
      const debut = this.courant + 1;
      for (let k = 0; k < n; k++) {
        const i = (debut + k) % n;
        if (this.vue[i].nom.toLowerCase().startsWith(l)) return aller(i);
      }
    }
  }
}

let glisse = null; // { cote, elements } pendant un glisser entre volets
function marquerDepot(volet, tr) {
  for (const v of Object.values(volets)) {
    const ici = v === volet;
    v.racine.classList.toggle("depot-actif", ici);
    v.racine.classList.toggle("depot-sur-dossier", ici && !!tr);
    for (const x of v.corps.querySelectorAll(".cible-depot")) if (x !== tr) x.classList.remove("cible-depot");
  }
  tr?.classList.add("cible-depot");
}
function finDepot() {
  for (const v of Object.values(volets)) {
    v.racine.classList.remove("depot-actif", "depot-sur-dossier");
    for (const x of v.corps.querySelectorAll(".cible-depot")) x.classList.remove("cible-depot");
  }
}
// Rien ne doit s'ouvrir dans la fenêtre si l'on lâche un fichier hors des volets.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

const volets = {};
let actif = "local";
function activer(cote) {
  actif = cote;
  for (const v of Object.values(volets)) v.racine.classList.toggle("actif", v.cote === cote);
  majBoutons();
}

function majBoutons() {
  if (!volets.local || !volets.distant) return;
  const l = volets.local;
  const d = volets.distant;
  const btn = (v, action) => v.racine.querySelector(`[data-action="${action}"]`);
  btn(l, "parent").disabled = l.parent == null;
  btn(d, "parent").disabled = d.parent == null;
  btn(l, "transferer").disabled = !l.selectionnes().some((e) => !e.ignore);
  btn(d, "transferer").disabled = !d.selectionnes().length;
  btn(d, "renommer").disabled = d.selectionnes().length !== 1;
  btn(d, "supprimer").disabled = !d.selectionnes().length;
}

function majRappel() {
  const d = volets.distant;
  const dansOptionnels = d.chemin === "optionalmod" || d.chemin?.startsWith("optionalmod/");
  const r = $("rappel");
  r.classList.toggle("fort", !!dansOptionnels);
  r.querySelector("span").textContent = "";
  r.querySelector("span").append(
    ...(dansOptionnels
      ? ["Mods optionnels : chaque jar de ce dossier est proposé aux joueurs dans le launcher. Tout changement est reçu au prochain « Jouer »."]
      : [el("b", { texte: "optionalmod" }), " contient les mods optionnels du launcher. Tout changement ici est reçu par les joueurs au prochain « Jouer »."]),
  );
}

/* Transferts */

// Transfère des éléments du volet source vers le dossier ouvert de l'autre volet (ou un de ses sous-dossiers).
async function transferer(source, elements, dossierCible = null) {
  const cible = source.autre;
  elements = elements.filter((e) => !e.ignore);
  if (!elements.length) return annoncer("Ces éléments ne sont jamais envoyés : fichiers cachés ou système.");
  if (cible.chemin == null) return;
  const dest = dossierCible ?? cible.chemin;
  // Remplacement : on ne connaît que le contenu du dossier ouvert de l'autre côté.
  if (dossierCible == null) {
    const existants = new Set(cible.entrees.map((e) => e.nom));
    const doublons = elements.filter((e) => existants.has(e.nom));
    if (doublons.length && !(await confirmerRemplacement(doublons, source.cote === "local" ? "sur le serveur" : "sur le PC"))) return;
  }
  const r =
    source.cote === "local"
      ? await li.envoyer(elements.map((e) => source.cheminDe(e)), dest)
      : await li.telecharger(elements.map((e) => ({ chemin: source.cheminDe(e), dossier: e.dossier, taille: e.taille ?? 0 })), dest);
  if (!r.ok) annoncer(r.erreur, { erreur: true });
}

// Un dossier qui existe déjà de l'autre côté n'est pas remplacé : il est complété (fichiers nouveaux ajoutés,
// fichiers de même nom remplacés, rien de supprimé). Seuls les fichiers de même nom sont remplacés.
function confirmerRemplacement(doublons, ou) {
  const dossiers = doublons.filter((e) => e.dossier);
  const fichiers = doublons.filter((e) => !e.dossier);
  const nomDossiers = dossiers.length === 1 ? `le dossier « ${dossiers[0].nom} »` : `${dossiers.length} dossiers`;
  const nomFichiers = fichiers.length === 1 ? `« ${fichiers[0].nom} »` : `${fichiers.length} fichiers`;

  let titre, oui;
  if (!fichiers.length) {
    titre = dossiers.length === 1 ? `Le dossier « ${dossiers[0].nom} » existe déjà ${ou}` : `${dossiers.length} dossiers existent déjà ${ou}`;
    oui = dossiers.length === 1 ? "Ajouter au dossier" : "Ajouter aux dossiers";
  } else if (!dossiers.length) {
    titre = fichiers.length === 1 ? `« ${fichiers[0].nom} » existe déjà ${ou}` : `${fichiers.length} fichiers existent déjà ${ou}`;
    oui = "Remplacer";
  } else {
    titre = `${doublons.length} éléments existent déjà ${ou}`;
    oui = "Continuer";
  }

  const explications = [];
  if (dossiers.length) {
    explications.push(
      el("p", {
        texte: `Rien n'est remplacé en bloc : ${nomDossiers} ${dossiers.length === 1 ? "est complété" : "sont complétés"}. Les fichiers nouveaux s'y ajoutent, ceux du même nom sont remplacés par votre version, et rien n'y est supprimé.`,
      }),
      el("p", { class: "aide", texte: "Pour retirer aussi ce qui n'existe plus sur votre PC, utilisez plutôt « Synchroniser »." }),
    );
  }
  if (fichiers.length) explications.push(el("p", { texte: `${nomFichiers} ${fichiers.length === 1 ? "sera remplacé" : "seront remplacés"} par votre version.` }));

  return confirmer(
    titre,
    [el("ul", { class: "liste-courte" }, doublons.slice(0, 50).map((e) => el("li", {}, el("span", { texte: e.nom }), el("span", { texte: e.dossier ? "dossier" : taille(e.taille) })))), ...explications],
    { oui },
  );
}

// Fichiers lâchés depuis l'explorateur du système sur le volet serveur.
async function envoyerChemins(elements, dossierCible) {
  const d = volets.distant;
  if (dossierCible == null) {
    const existants = new Set(d.entrees.map((e) => e.nom));
    const doublons = elements.filter((e) => existants.has(e.nom));
    if (doublons.length && !(await confirmerRemplacement(doublons, "sur le serveur"))) return;
  }
  const r = await li.envoyer(elements.map((e) => e.chemin), dossierCible ?? d.chemin);
  if (!r.ok) annoncer(r.erreur, { erreur: true });
}

const ETATS = { attente: "En attente", preparation: "Préparation", encours: "En cours", fini: "Terminé", erreur: "Échec", annule: "Annulé" };
const lignesFile = new Map();

function rendreFile(liste) {
  const ol = $("file-liste");
  const vus = new Set();
  // Les plus récentes en haut.
  const ordre = [...liste].reverse();
  ordre.forEach((t, rang) => {
    vus.add(t.id);
    let x = lignesFile.get(t.id);
    if (!x) {
      x = {
        li: el("li", { class: "tache" }),
        sens: el("span", { class: "tache-sens", "aria-hidden": "true" }),
        titre: el("b"),
        detail: el("small"),
        barre: el("i"),
        chiffres: el("span"),
        sous: el("small"),
        etat: el("span", { class: "tache-etat" }),
        annuler: el("button", { class: "icone-seule", title: "Annuler ce transfert", "aria-label": `Annuler ${t.titre}`, onclick: () => li.annulerTransfert(t.id) }, icone("fermer")),
        erreur: el("div", { class: "tache-erreur", role: "alert" }),
      };
      x.sens.append(icone(t.sens === "envoi" ? "envoyer" : t.sens === "telechargement" ? "telecharger" : "sync"));
      x.li.append(
        x.sens,
        el("div", { class: "tache-titre" }, x.titre, x.detail),
        el("div", { class: "barre-progres", role: "progressbar", "aria-label": `Progression de ${t.titre}`, "aria-valuemin": "0", "aria-valuemax": "100" }, x.barre),
        el("div", { class: "tache-chiffres" }, x.chiffres, x.sous),
        x.etat,
        x.annuler,
        x.erreur,
      );
      lignesFile.set(t.id, x);
    }
    x.li.dataset.etat = t.etat;
    x.li.dataset.sens = t.sens;
    x.titre.textContent = t.titre;
    x.titre.title = t.titre;
    x.detail.textContent = t.courant ? t.courant : t.detail;
    x.detail.title = x.detail.textContent;
    const pc = t.total ? Math.floor((t.fait / t.total) * 100) : t.etat === "fini" ? 100 : 0;
    x.barre.style.width = `${pc}%`;
    x.barre.parentElement.setAttribute("aria-valuenow", String(pc));
    x.chiffres.textContent = t.etat === "preparation" ? "Inventaire…" : t.total ? `${taille(t.fait)} sur ${taille(t.total)}` : t.etat === "fini" ? "Fait" : "";
    const sous = [];
    if (t.operations > 1) sous.push(`${t.faites.toLocaleString("fr-FR")} sur ${pluriel(t.operations, "élément")}`);
    if (t.etat === "encours" && t.vitesse > 0) sous.push(`${taille(t.vitesse)}/s`);
    if (t.etat === "fini" && t.fin && t.debut && t.total) sous.push(`en ${duree(t.fin - t.debut)}`);
    x.sous.textContent = sous.join(" · ");
    x.etat.textContent = ETATS[t.etat] ?? t.etat;
    x.annuler.hidden = ["fini", "erreur", "annule"].includes(t.etat);
    x.erreur.hidden = !t.erreur;
    x.erreur.textContent = t.erreur ?? "";
    if (ol.children[rang] !== x.li) ol.insertBefore(x.li, ol.children[rang] ?? null);
  });
  for (const [id, x] of lignesFile) if (!vus.has(id)) (x.li.remove(), lignesFile.delete(id));

  $("file-vide").hidden = liste.length > 0;
  const actives = liste.filter((t) => t.etat === "encours" || t.etat === "preparation").length;
  const attente = liste.filter((t) => t.etat === "attente").length;
  const echecs = liste.filter((t) => t.etat === "erreur").length;
  const vitesse = liste.reduce((s, t) => s + (t.etat === "encours" ? t.vitesse : 0), 0);
  $("file-resume").textContent = [actives ? `${actives} en cours` : null, attente ? `${attente} en attente` : null, echecs ? pluriel(echecs, "échec") : null, vitesse ? `${taille(vitesse)}/s` : null].filter(Boolean).join(" · ");
  $("file-effacer").disabled = !liste.some((t) => ["fini", "erreur", "annule"].includes(t.etat));
}

function duree(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/* Actions des barres d'outils */

async function action(cote, nom) {
  const v = volets[cote];
  switch (nom) {
    case "parent":
      return v.monter();
    case "actualiser":
      return v.actualiser();
    case "transferer":
      return transferer(v, v.selectionnes());
    case "choisir": {
      const r = await li.localChoisir(v.chemin);
      if (r.ok && r.dossier) v.aller(r.dossier);
      return;
    }
    case "explorateur": {
      const sel = v.selectionnes();
      const r = await li.localOuvrir(sel.length === 1 ? v.cheminDe(sel[0]) : v.chemin);
      if (!r.ok) annoncer(r.erreur, { erreur: true });
      return;
    }
    case "nouveau": {
      const existants = new Set(v.entrees.map((e) => e.nom.toLowerCase()));
      const nom = await demanderNom({
        titre: cote === "local" ? "Nouveau dossier sur le PC" : "Nouveau dossier sur le serveur",
        aide: cote === "distant" ? `Dans ${v.chemin ? "/" + v.chemin : "la racine"}.` : null,
        oui: "Créer",
        verifier: (n) => (cote === "distant" ? refusNom(n) : !n ? "Le nom est vide." : /[\\/:*?"<>|]/.test(n) ? 'Ces caractères sont interdits dans un nom : \\ / : * ? " < > |' : null) || (existants.has(n.toLowerCase()) ? "Un élément porte déjà ce nom." : null),
      });
      if (!nom) return;
      const r = cote === "local" ? await li.localNouveauDossier(v.chemin, nom) : await li.distantNouveauDossier(v.chemin, nom);
      if (!r.ok) return annoncer(r.erreur, { erreur: true });
      return v.aller(v.chemin, { choisir: nom });
    }
    case "renommer": {
      const [e] = v.selectionnes();
      if (!e || cote !== "distant") return;
      const existants = new Set(v.entrees.filter((x) => x !== e).map((x) => x.nom.toLowerCase()));
      const nom = await demanderNom({
        titre: `Renommer « ${e.nom} »`,
        valeur: e.nom,
        oui: "Renommer",
        verifier: (n) => refusNom(n) || (existants.has(n.toLowerCase()) ? "Un élément porte déjà ce nom." : null),
      });
      if (!nom || nom === e.nom) return;
      const r = await li.distantRenommer(v.cheminDe(e), nom);
      if (!r.ok) return annoncer(r.erreur, { erreur: true });
      annoncer(`« ${e.nom} » renommé en « ${nom} ».`);
      return v.aller(v.chemin, { choisir: nom });
    }
    case "supprimer": {
      const sel = v.selectionnes();
      if (!sel.length || cote !== "distant") return;
      const fichiers = sel.reduce((s, e) => s + (e.dossier ? e.fichiers ?? 0 : 1), 0);
      const ok = await confirmer(
        sel.length === 1 ? `Supprimer « ${sel[0].nom} » du serveur ?` : `Supprimer ${sel.length} éléments du serveur ?`,
        [
          el("ul", { class: "liste-courte" }, sel.map((e) => el("li", {}, el("span", { texte: (v.chemin ? `/${v.chemin}/` : "/") + e.nom }), el("span", { texte: e.dossier ? `dossier, ${pluriel(e.fichiers ?? 0, "fichier")}` : taille(e.taille) })))),
          el("p", { class: "alerte" }, `Suppression définitive de ${pluriel(fichiers, "fichier")}, sans corbeille. Les joueurs les perdront au prochain « Jouer ».`),
        ],
        { oui: "Supprimer", style: "danger", defautNon: true },
      );
      if (!ok) return;
      const r = await li.distantSupprimer(sel.map((e) => v.cheminDe(e)));
      if (!r.ok) annoncer(r.erreur, { erreur: true });
      else annoncer(sel.length === 1 ? `« ${sel[0].nom} » supprimé.` : `${sel.length} éléments supprimés.`);
      return v.actualiser();
    }
  }
}

for (const cote of ["local", "distant"]) {
  document.getElementById(`volet-${cote}`).querySelector(".outils").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-action]");
    if (b && !b.disabled) action(cote, b.dataset.action);
  });
}

// Raccourcis valables dans tout l'écran principal (le volet actif reçoit l'action).
document.addEventListener("keydown", (ev) => {
  if ($("ecran-principal").hidden || dlg.open) return;
  if (ev.target.closest?.("input, textarea")) return;
  const v = volets[actif];
  const touches = { F5: "actualiser", F6: "transferer", F7: "nouveau", F2: "renommer", Delete: "supprimer" };
  let nom = touches[ev.key];
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === "r" || ev.key === "R")) nom = "actualiser";
  if (!nom) return;
  ev.preventDefault();
  if ((nom === "renommer" || nom === "supprimer") && actif !== "distant") return;
  if (nom === "transferer") return transferer(v, v.selectionnes().length ? v.selectionnes() : v.vue[v.courant] ? [v.vue[v.courant]] : []);
  if (nom === "renommer" && v.selectionnes().length !== 1 && v.vue[v.courant]) v.selectionner(v.courant);
  if (nom === "supprimer" && !v.selectionnes().length && v.vue[v.courant]) v.selectionner(v.courant);
  action(actif, nom);
});

/* Synchronisation : choix, aperçu calculé, puis application après confirmation. */

async function synchroniser() {
  const l = volets.local;
  const d = volets.distant;
  if (l.chemin == null || d.chemin == null) return;
  const route = el(
    "div",
    { class: "sync-route" },
    el("div", {}, el("small", { texte: "Depuis le PC" }), el("b", { title: l.chemin, texte: `\u200e${l.chemin}` })),
    icone("envoyer"),
    el("div", {}, el("small", { texte: "Vers le serveur" }), el("b", { title: d.chemin || "racine", texte: `\u200e/${d.chemin}` })),
  );
  const caseSuppr = el("input", { type: "checkbox", checked: true });
  const choix = await dialogue({
    titre: "Synchroniser",
    large: true,
    corps: [
      route,
      el("p", { texte: "Le dossier du serveur devient la copie du dossier du PC : les fichiers absents sont envoyés, ceux qui diffèrent (empreinte SHA-1) sont remplacés. Rien n'est fait avant que vous ayez vu et accepté l'aperçu." }),
      el("label", { class: "case" }, caseSuppr, el("span", { texte: "Supprimer sur le serveur ce qui n'existe pas sur le PC" })),
      d.chemin === "" ? el("p", { class: "alerte", texte: "Le dossier du serveur ouvert est la racine : tous les fichiers du jeu sont concernés." }) : null,
    ],
    actions: [
      { texte: "Annuler", valeur: null },
      { texte: "Calculer l'aperçu", style: "principal", defaut: true, agir: () => fermerDialogue({ supprimer: caseSuppr.checked }) },
    ],
  });
  if (!choix) return;

  // Calcul de l'aperçu, avec sa progression.
  const etape = el("b", { texte: "Préparation" });
  const detail = el("small", { texte: "" });
  const barre = el("i");
  barre.style.width = "0%";
  const progres = el("div", { class: "progres-etape" }, etape, el("div", { class: "barre-progres" }, barre), detail);
  const fin = li.surSyncEtape((e) => {
    etape.textContent = e.etape;
    detail.textContent = e.fichier ?? "";
    barre.style.width = e.total ? `${Math.floor((e.fait / e.total) * 100)}%` : "0%";
  });
  let annule = false;
  dialogue({
    titre: "Calcul de l'aperçu",
    large: true,
    fermable: false,
    corps: [route, progres],
    actions: [{ texte: "Annuler", agir: () => ((annule = true), li.syncAnnulerApercu()) }],
  });
  const a = await li.syncApercu({ dossierLocal: l.chemin, dossierDistant: d.chemin, supprimer: choix.supprimer });
  fin();
  if (annule) return fermerDialogue();
  if (!a.ok) {
    fermerDialogue();
    return dialogue({ titre: "Synchronisation impossible", corps: [el("p", { class: "alerte", texte: a.erreur })], actions: [{ texte: "Fermer", defaut: true }] });
  }

  const rien = !a.envoyer.length && !a.remplacer.length && !a.supprimer.length;
  const groupe = (titre, liste, ouvert) =>
    liste.length
      ? el(
          "details",
          { class: "groupe", open: ouvert || null },
          el("summary", {}, `${titre} (${liste.length.toLocaleString("fr-FR")})`, el("small", { texte: taille(liste.reduce((s, f) => s + f.taille, 0)) })),
          el("ul", { class: "liste-courte" }, liste.slice(0, 500).map((f) => el("li", {}, el("span", { texte: f.chemin, title: f.chemin }), el("span", { texte: taille(f.taille) }))), liste.length > 500 ? el("li", {}, el("span", { texte: `… et ${liste.length - 500} de plus` })) : null),
        )
      : null;
  const cases = (classe, n, texte) => el("div", { class: classe }, el("b", { texte: n.toLocaleString("fr-FR") }), el("small", { texte }));
  const avertissements = [];
  if (a.supprimer.length) avertissements.push(el("p", { class: "alerte", texte: `${pluriel(a.supprimer.length, "fichier")} du serveur ${a.supprimer.length > 1 ? "seront supprimés" : "sera supprimé"} définitivement.` }));
  if (a.envoyer.length + a.remplacer.length > 2000 || a.octets > 4 * 1024 ** 3) avertissements.push(el("p", { class: "alerte", texte: "Beaucoup de données à envoyer : vérifiez que le dossier du PC est le bon." }));
  if (!rien) avertissements.push(el("p", { class: "rappel-bloc", texte: "Les joueurs recevront ces changements au prochain « Jouer » (et les jars de optionalmod deviennent des mods optionnels)." }));

  const ok = await dialogue({
    titre: rien ? "Tout est déjà à jour" : "Aperçu de la synchronisation",
    large: true,
    corps: [
      route,
      el("div", { class: "sync-bilan" }, cases("envoyer", a.envoyer.length, "à envoyer (absents)"), cases("remplacer", a.remplacer.length, "à remplacer (différents)"), cases("supprimer", a.supprimer.length, a.supprimerActive ? "à supprimer sur le serveur" : "suppression désactivée"), cases("", a.identiques, "identiques")),
      rien ? el("p", { texte: "Le dossier du serveur est déjà identique au dossier du PC." }) : el("p", { texte: `${taille(a.octets)} à envoyer.` }),
      groupe("À envoyer", a.envoyer, a.envoyer.length <= 30),
      groupe("À remplacer", a.remplacer, a.remplacer.length <= 30),
      groupe("À supprimer sur le serveur", a.supprimer, true),
      ...avertissements,
    ],
    actions: rien ? [{ texte: "Fermer", defaut: true }] : [{ texte: "Annuler", valeur: false, defaut: !!a.supprimer.length }, { texte: "Appliquer", valeur: true, style: a.supprimer.length ? "danger" : "principal", defaut: !a.supprimer.length }],
  });
  if (ok !== true) return;
  const r = await li.syncAppliquer(a.id);
  if (!r.ok) annoncer(r.erreur, { erreur: true });
}

/* Connexion */

let infos = {};

function montrerConnexion({ erreur = null } = {}) {
  $("ecran-principal").hidden = true;
  $("ecran-connexion").hidden = false;
  $("c-nom").value = infos.nom ?? "";
  $("c-mdp").value = "";
  $("c-souvenir").checked = !!infos.souvenir;
  $("c-souvenir").disabled = !infos.chiffrement;
  $("c-note").textContent = infos.chiffrement ? "Le mot de passe est chiffré par le système, jamais écrit en clair." : "Ce système ne permet pas de chiffrer le mot de passe : il ne peut pas être retenu.";
  montrerErreur(erreur);
  ($("c-nom").value ? $("c-mdp") : $("c-nom")).focus();
}
function montrerErreur(m) {
  $("c-erreur").hidden = !m;
  $("c-erreur").textContent = m ?? "";
}

$("c-voir").addEventListener("click", () => {
  const voir = $("c-mdp").type === "password";
  $("c-mdp").type = voir ? "text" : "password";
  $("c-voir").setAttribute("aria-pressed", String(voir));
  $("c-voir").setAttribute("aria-label", voir ? "Masquer le mot de passe" : "Afficher le mot de passe");
});

$("form-connexion").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const nom = $("c-nom").value.trim();
  const motDePasse = $("c-mdp").value;
  if (!nom || !motDePasse) {
    montrerErreur("Saisissez le nom et le mot de passe du compte d'accès.");
    return (nom ? $("c-mdp") : $("c-nom")).focus();
  }
  const b = $("c-valider");
  b.disabled = true;
  b.textContent = "Vérification…";
  montrerErreur(null);
  const r = await li.connexion({ nom, motDePasse, souvenir: $("c-souvenir").checked });
  b.disabled = false;
  b.textContent = "Se connecter";
  if (!r.ok) {
    montrerErreur(r.erreur);
    $("c-mdp").select();
    return $("c-mdp").focus();
  }
  $("c-mdp").value = "";
  infos.nom = nom;
  infos.souvenir = $("c-souvenir").checked;
  if (r.avertissement) annoncer(r.avertissement);
  entrer(r.nom);
});

let fileEcoutee = false;
async function entrer(nom) {
  $("ecran-connexion").hidden = true;
  $("ecran-principal").hidden = false;
  $("compte-nom").textContent = nom;
  if (!volets.local) {
    volets.local = new Volet("local");
    volets.distant = new Volet("distant");
  }
  if (!fileEcoutee) {
    fileEcoutee = true;
    li.surTransferts(rendreFile);
    // À la fin d'un transfert, le volet qui montre la destination se met à jour.
    li.surTransfertFini(({ cible }) => {
      const v = cible && volets[cible.cote];
      if (!v || v.chemin == null) return;
      const sep = cible.cote === "local" ? v.separateur : "/";
      const parent = cible.chemin.includes(sep) ? cible.chemin.slice(0, cible.chemin.lastIndexOf(sep)) : "";
      if (v.chemin === cible.chemin || v.chemin === parent) v.actualiser();
    });
  }
  rendreFile([]);
  activer("local");
  const depart = await li.localDepart();
  await Promise.all([volets.local.aller(depart.dossier), volets.distant.aller("")]);
  volets.local.liste.focus();
}

$("b-deconnexion").addEventListener("click", async () => {
  const enCours = [...lignesFile.values()].some((x) => ["attente", "preparation", "encours"].includes(x.li.dataset.etat));
  if (enCours && !(await confirmer("Se déconnecter ?", "Des transferts sont en cours : ils seront arrêtés. Les gros envois reprendront là où ils en étaient la prochaine fois.", { oui: "Se déconnecter", style: "danger", defautNon: true }))) return;
  await li.deconnexion();
  infos.souvenir = false;
  for (const x of lignesFile.values()) x.li.remove();
  lignesFile.clear();
  montrerConnexion();
});
$("b-sync").addEventListener("click", synchroniser);
$("file-effacer").addEventListener("click", () => li.effacerTransferts());

li.surSessionPerdue(({ erreur }) => {
  if (!$("ecran-principal").hidden) {
    fermerDialogue();
    li.deconnexion();
    montrerConnexion({ erreur: `Session refusée par le site : ${erreur}` });
  }
});

/* Mise à jour du logiciel : proposée au démarrage, comme le launcher. */

async function proposerMaj() {
  const r = await li.majVerifier();
  if (!r.ok || !r.nouvelle) return;
  const v = r.nouvelle.version;
  const oui = await confirmer(`Version ${v} disponible`, `Vous utilisez la version ${infos.version}. Le logiciel va télécharger la nouvelle, l'installer, puis redémarrer tout seul.`, { oui: "Mettre à jour", non: "Plus tard" });
  if (!oui) return;
  const texte = el("p", { texte: "Téléchargement…" });
  const barre = el("i");
  const fin = li.surMajProgression(({ fait, total }) => {
    barre.style.width = total ? `${Math.floor((fait / total) * 100)}%` : "0%";
    texte.textContent = total ? `Téléchargement : ${taille(fait)} sur ${taille(total)}` : "Téléchargement…";
  });
  dialogue({ titre: `Mise à jour vers la version ${v}`, fermable: false, corps: [texte, el("div", { class: "barre-progres" }, barre)] });
  const res = await li.majInstaller();
  fin();
  if (res.ok) {
    texte.textContent = "Installation : le logiciel va redémarrer.";
    return;
  }
  majDialogue({ titre: "Mise à jour impossible", corps: [el("p", { class: "alerte", texte: res.erreur })], actions: [{ texte: "Fermer", defaut: true, agir: () => fermerDialogue() }] });
}

/* Démarrage */

(async function demarrer() {
  const d = await li.demarrage();
  infos = d.ok ? d : { version: "?", chiffrement: false };
  $("c-pied").textContent = `Version ${infos.version}`;
  $("version").textContent = `Lost Island Fichiers ${infos.version}`;
  $("badge-essai").hidden = !infos.essai;
  if (infos.session) await entrer(infos.session.nom);
  else montrerConnexion({ erreur: infos.erreurAuto ? `Connexion automatique impossible : ${infos.erreurAuto}` : null });
  proposerMaj();
  if (infos.essai?.scenario) scenarioEssai(infos.essai.scenario);
})();

// Mode d'essai seulement (LI_ESSAI_SCENARIO, jamais dans l'application installée) : met l'interface dans un
// état donné pour la photographier.
async function scenarioEssai(s) {
  const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));
  if (s === "erreur-connexion") return montrerErreur("Nom ou mot de passe incorrect.");
  await attendre(400);
  if (s === "dossier-existant") return confirmerRemplacement([{ nom: "mods", dossier: true }], "sur le serveur");
  const l = volets.local;
  const d = volets.distant;
  if (s === "file" || s === "selection") {
    await d.aller("mods");
    d.selectionner(0);
    d.selectionner(2, { ctrl: true });
    await l.aller(l.chemin + l.separateur + "mods");
    l.selectionner(1);
    l.selectionner(2, { maj: true });
    activer("local");
    l.liste.focus();
  }
  if (s === "file") {
    await li.envoyer(l.selectionnes().map((e) => l.cheminDe(e)), "mods");
    await li.telecharger([{ chemin: "resourcepacks", dossier: true }], l.chemin);
    await li.envoyer([l.cheminDe(l.vue[0])], "mods");
  }
  if (s === "sync") {
    await l.aller(l.chemin);
    synchroniser();
    await attendre(300);
    dlg.querySelector(".dialogue-actions [data-defaut]")?.click();
  }
  if (s === "suppression") {
    await d.aller("mods");
    d.selectionner(0);
    d.selectionner(1, { ctrl: true });
    action("distant", "supprimer");
  }
  if (s === "renommer") {
    await d.aller("mods");
    d.selectionner(1);
    action("distant", "renommer");
  }
}
