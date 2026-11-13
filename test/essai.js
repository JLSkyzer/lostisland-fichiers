// Essais automatiques, sans Electron et sans le vrai site : `npm run essai` (ou `node test/essai.js`).
// 1. Les fonctions pures du contrat (découpage, reprise, aperçu de synchronisation, messages).
// 2. Le client et la file de transferts contre le serveur factice (outils/serveur-factice.js), qui n'écoute
//    que sur 127.0.0.1 : rien ne sort de la machine. Seuils réduits pour aller vite (300 Kio, morceaux de
//    128 Kio) ; les valeurs réelles du contrat sont vérifiées à part.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contrat = require("../src/main/contrat");
const { Client } = require("../src/main/api");
const { Reprises } = require("../src/main/reprises");
const { FileTransferts } = require("../src/main/transferts");
const operations = require("../src/main/operations");
const { demarrer } = require("../outils/serveur-factice");

const Kio = 1024;

/* 1. Fonctions pures */

test("seuils du contrat : 90 Mo et morceaux de 50 Mo", () => {
  assert.equal(contrat.SEUIL_MORCEAUX, 90 * 1024 * 1024);
  assert.equal(contrat.TAILLE_MORCEAU, 50 * 1024 * 1024);
  assert.equal(contrat.planMorceaux(90 * 1024 * 1024), null, "90 Mo pile : une seule requête");
  const p = contrat.planMorceaux(90 * 1024 * 1024 + 1);
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], { index: 0, debut: 0, fin: 50 * 1024 * 1024 });
  assert.deepEqual(p[1], { index: 1, debut: 50 * 1024 * 1024, fin: 90 * 1024 * 1024 + 1 });
  const g = contrat.planMorceaux(1234567890);
  assert.equal(g.length, Math.ceil(1234567890 / (50 * 1024 * 1024)));
  assert.equal(g.at(-1).fin, 1234567890);
  for (let i = 1; i < g.length; i++) assert.equal(g[i].debut, g[i - 1].fin, "morceaux contigus");
  assert.ok(g.slice(0, -1).every((m) => m.fin - m.debut === 50 * 1024 * 1024), "50 Mo exactement sauf le dernier");
  assert.throws(() => contrat.planMorceaux(2001 * 50 * 1024 * 1024));
  assert.equal(contrat.planMorceaux(0), null);
});

test("reprise : seuls les morceaux absents, puis toujours le dernier", () => {
  assert.deepEqual(contrat.morceauxAEnvoyer(5, []), [0, 1, 2, 3, 4]);
  assert.deepEqual(contrat.morceauxAEnvoyer(5, [0, 1, 4]), [2, 3, 4]);
  assert.deepEqual(contrat.morceauxAEnvoyer(5, [0, 1, 2, 3]), [4]);
  assert.deepEqual(contrat.morceauxAEnvoyer(1, [0]), [0]);
  assert.deepEqual(contrat.morceauxAEnvoyer(3, [7, -1, 1.5, 1]), [0, 2]);
});

test("identifiant d'envoi et clé de reprise", () => {
  for (let i = 0; i < 50; i++) assert.match(contrat.nouvelIdEnvoi(), contrat.ID_ENVOI);
  assert.notEqual(contrat.nouvelIdEnvoi(), contrat.nouvelIdEnvoi());
  assert.equal(contrat.cleReprise("/mods/x.jar/", 10, 1700000000123.7), "mods/x.jar|10|1700000000123");
  assert.notEqual(contrat.cleReprise("mods/x.jar", 10, 1), contrat.cleReprise("mods/x.jar", 10, 2));
});

test("fichiers jamais envoyés et noms refusés", () => {
  for (const n of [".git", ".DS_Store", "Thumbs.db", "thumbs.DB", "desktop.ini", "Desktop.ini"]) assert.ok(contrat.ignore(n), n);
  for (const n of ["mods", "x.jar", "options.txt"]) assert.ok(!contrat.ignore(n), n);
  assert.equal(contrat.refusNom("ok.jar"), null);
  assert.ok(contrat.refusNom(".cache"));
  assert.ok(contrat.refusNom("a:b"));
  assert.ok(contrat.refusNom("  "));
  assert.ok(contrat.refusNom("x".repeat(151)));
});

test("chemins du serveur", () => {
  assert.equal(contrat.normaliser("/mods//x.jar/"), "mods/x.jar");
  assert.equal(contrat.normaliser("mods\\x.jar"), "mods/x.jar");
  assert.equal(contrat.joindre("", "mods"), "mods");
  assert.equal(contrat.joindre("config", "a/b.toml"), "config/a/b.toml");
  assert.equal(contrat.parent("config/a/b.toml"), "config/a");
  assert.equal(contrat.parent("mods"), "");
  assert.equal(contrat.nomDe("config/a/b.toml"), "b.toml");
});

test("aperçu de synchronisation", () => {
  const local = [
    { chemin: "neuf.jar", taille: 5 },
    { chemin: "pareil.jar", taille: 3, sha1: "AAA" },
    { chemin: "change.jar", taille: 3, sha1: "bbb" },
    { chemin: "taille.jar", taille: 9 },
    { chemin: "cfg/garde.toml", taille: 1, sha1: "c" },
  ];
  const distant = [
    { chemin: "pareil.jar", taille: 3, sha1: "aaa" },
    { chemin: "change.jar", taille: 3, sha1: "ccc" },
    { chemin: "taille.jar", taille: 4, sha1: "x" },
    { chemin: "cfg/garde.toml", taille: 1, sha1: "c" },
    { chemin: "cfg/vieux.toml", taille: 1, sha1: "d" },
    { chemin: "ancien/a/b.txt", taille: 1, sha1: "e" },
    { chemin: "ancien/c.txt", taille: 1, sha1: "f" },
  ];
  assert.deepEqual(contrat.aHacher(local, distant).sort(), ["cfg/garde.toml", "change.jar", "pareil.jar"]);
  const a = contrat.apercuSync(local, distant, { dossiersLocaux: ["cfg"] });
  assert.deepEqual(a.envoyer.map((f) => f.chemin), ["neuf.jar"]);
  assert.deepEqual(a.remplacer.map((f) => f.chemin), ["change.jar", "taille.jar"]);
  assert.deepEqual(a.supprimer.map((f) => f.chemin), ["ancien/a/b.txt", "ancien/c.txt", "cfg/vieux.toml"]);
  assert.deepEqual(a.suppressions, ["ancien", "cfg/vieux.toml"], "un dossier absent en local part d'un coup");
  assert.equal(a.identiques, 2);
  assert.equal(a.octets, 5 + 3 + 9);
  const sans = contrat.apercuSync(local, distant, { supprimer: false });
  assert.equal(sans.supprimer.length, 0);
  assert.equal(sans.suppressions.length, 0);
  assert.throws(() => contrat.apercuSync([{ chemin: "pareil.jar", taille: 3 }], distant), /Empreinte locale manquante/);
});

test("regroupement des suppressions", () => {
  assert.deepEqual(contrat.regrouperSuppressions(["a/b/c", "a/b/d", "a/e"], ["a"], []), ["a/b", "a/e"]);
  assert.deepEqual(contrat.regrouperSuppressions(["a/b/c"], [], ["a/x"]), ["a/b"]);
  assert.deepEqual(contrat.regrouperSuppressions(["x"], [], []), ["x"]);
});

test("vitesse sur fenêtre glissante", () => {
  assert.equal(contrat.vitesse([], 0), 0);
  assert.equal(contrat.vitesse([{ t: 0, octets: 0 }, { t: 1000, octets: 500 }], 1000), 500);
  assert.equal(contrat.vitesse([{ t: 0, octets: 0 }, { t: 5000, octets: 9 }, { t: 6000, octets: 1009 }], 6000), 1000);
});

test("messages d'erreur en français", () => {
  assert.match(contrat.messageSysteme({ code: "ENOTFOUND" }), /injoignable/);
  assert.match(contrat.messageSysteme({ code: "ENOSPC" }), /place/);
  assert.match(contrat.messageSysteme({ code: "EBUSY" }), /verrouillé/);
  assert.equal(contrat.messageHttp(401, "Nom ou mot de passe incorrect."), "Nom ou mot de passe incorrect.");
  assert.match(contrat.messageHttp(502, null), /502/);
  assert.ok(contrat.aRetenter({ statut: 503 }));
  assert.ok(!contrat.aRetenter({ statut: 400 }));
  assert.ok(contrat.aRetenter({ code: "ECONNRESET" }));
  assert.ok(!contrat.aRetenter({ name: "AbortError" }));
});

test("reprises gardées sur disque", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lif-rep-"));
  const f = path.join(d, "reprises.json");
  const r = new Reprises(f);
  assert.equal(r.trouver("k"), null);
  r.garder("k", "abcdefgh12");
  assert.equal(new Reprises(f).trouver("k"), "abcdefgh12", "relu après redémarrage");
  r.oublier("k");
  assert.equal(new Reprises(f).trouver("k"), null);
  fs.writeFileSync(f, JSON.stringify({ vieux: { id: "abcdefgh12", cree: Date.now() - 2 * 86400000 } }));
  assert.equal(new Reprises(f).trouver("vieux"), null, "plus d'un jour : oublié");
  fs.rmSync(d, { recursive: true, force: true });
});

/* 2. Contre le serveur factice */

test("client et file contre le serveur factice", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lif-essai-"));
  const racine = path.join(tmp, "serveur");
  const pc = path.join(tmp, "pc");
  fs.mkdirSync(pc);
  const srv = await demarrer({ racine, comptes: { equipe: "sésame" } });
  const reprises = new Reprises(path.join(tmp, "reprises.json"));
  const options = { base: srv.base, nom: "equipe", motDePasse: "sésame", seuil: 300 * Kio, tailleMorceau: 128 * Kio, delaiEssai: 10, reprises };
  const client = new Client(options);
  const aleatoire = (n) => crypto.randomBytes(n);
  t.after(async () => {
    client.fermer();
    await srv.fermer();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test("identifiants refusés", async () => {
    const mauvais = new Client({ ...options, motDePasse: "non" });
    await assert.rejects(mauvais.liste(""), (e) => e.statut === 401 && e.message === "Nom ou mot de passe incorrect.");
    mauvais.fermer();
  });

  await t.test("site injoignable", async () => {
    const loin = new Client({ ...options, base: "http://127.0.0.1:1/api/fichiers" });
    await assert.rejects(loin.liste(""), /injoignable/);
    loin.fermer();
  });

  await t.test("petit fichier : envoi, liste, téléchargement", async () => {
    const f = path.join(pc, "petit.bin");
    fs.writeFileSync(f, aleatoire(20 * Kio));
    let octets = 0;
    const r = await client.envoyer(f, "mods/petit.bin", { surOctets: (n) => (octets += n) });
    assert.equal(r.morceaux, 0);
    assert.equal(octets, 20 * Kio);
    const l = await client.liste("mods");
    assert.equal(l.entrees[0].nom, "petit.bin");
    const dest = path.join(tmp, "retour", "petit.bin");
    await client.telecharger("mods/petit.bin", dest);
    assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(f)));
    assert.ok(!fs.existsSync(dest + ".lipart"));
  });

  await t.test("gros fichier en morceaux, identique à l'arrivée", async () => {
    const f = path.join(pc, "gros.bin");
    fs.writeFileSync(f, aleatoire(700 * Kio)); // 6 morceaux de 128 Kio (le dernier de 60 Kio)
    srv.stats.morceaux.length = 0;
    let octets = 0;
    const r = await client.envoyer(f, "gros.bin", { surOctets: (n) => (octets += n) });
    assert.equal(r.morceaux, 6);
    assert.equal(octets, 700 * Kio);
    assert.deepEqual(srv.stats.morceaux.map((m) => m.morceau), [0, 1, 2, 3, 4, 5]);
    assert.ok(srv.stats.morceaux.slice(0, -1).every((m) => m.longueur === 128 * Kio));
    assert.ok(fs.readFileSync(path.join(racine, "gros.bin")).equals(fs.readFileSync(f)));
    assert.equal(reprises.lire()[contrat.cleReprise("gros.bin", 700 * Kio, fs.statSync(f).mtimeMs)], undefined, "reprise oubliée une fois fini");
  });

  await t.test("coupure : morceau retenté, puis reprise après « redémarrage »", async () => {
    const f = path.join(pc, "coupe.bin");
    fs.writeFileSync(f, aleatoire(900 * Kio)); // 8 morceaux
    // a) une coupure isolée : le morceau est retenté et l'envoi aboutit.
    srv.stats.morceaux.length = 0;
    srv.pannes.couperMorceau = 2;
    await client.envoyer(f, "coupe1.bin");
    assert.deepEqual(srv.stats.morceaux.map((m) => m.morceau), [0, 1, 2, 2, 3, 4, 5, 6, 7]);
    assert.ok(fs.readFileSync(path.join(racine, "coupe1.bin")).equals(fs.readFileSync(f)));

    // b) un envoi annulé après trois morceaux, puis repris par un nouveau client (comme après redémarrage).
    srv.stats.morceaux.length = 0;
    const ctrl = new AbortController();
    let vus = 0;
    await assert.rejects(
      client.envoyer(f, "coupe2.bin", {
        signal: ctrl.signal,
        surEtape: ({ morceau }) => {
          vus++;
          if (morceau === 3) ctrl.abort();
        },
      }),
      (e) => e.name === "AbortError",
    );
    assert.ok(vus >= 4);
    const recusAvant = new Set(srv.stats.morceaux.map((m) => m.morceau));
    assert.ok([0, 1, 2].every((i) => recusAvant.has(i)));
    const cle = contrat.cleReprise("coupe2.bin", 900 * Kio, fs.statSync(f).mtimeMs);
    assert.ok(new Reprises(reprises.fichier).trouver(cle), "identifiant gardé sur disque");

    const apres = new Client({ ...options, reprises: new Reprises(reprises.fichier) });
    srv.stats.morceaux.length = 0;
    let octets = 0;
    const r = await apres.envoyer(f, "coupe2.bin", { surOctets: (n) => (octets += n) });
    apres.fermer();
    assert.deepEqual(srv.stats.morceaux.map((m) => m.morceau), [3, 4, 5, 6, 7], "seuls les morceaux manquants");
    assert.equal(r.renvoyes, 5);
    assert.equal(octets, 900 * Kio, "la progression compte les morceaux déjà reçus");
    assert.ok(fs.readFileSync(path.join(racine, "coupe2.bin")).equals(fs.readFileSync(f)));
  });

  await t.test("opérations : dossier, renommer, supprimer", async () => {
    await client.creerDossier("config/neuf");
    await client.renommer("config/neuf", "config/renomme");
    assert.ok(fs.existsSync(path.join(racine, "config", "renomme")));
    await client.supprimer("config");
    assert.ok(!fs.existsSync(path.join(racine, "config")));
    await assert.rejects(client.renommer("absent", "x"), (e) => e.statut === 404);
    await assert.rejects(client.creerDossier(".cache"), (e) => e.statut === 400 && /Nom refusé/.test(e.message));
  });

  await t.test("file : dossier entier dans les deux sens, cachés ignorés, deux à la fois", async () => {
    const src = path.join(pc, "pack");
    fs.mkdirSync(path.join(src, "mods", "sous"), { recursive: true });
    fs.mkdirSync(path.join(src, "vide"));
    fs.mkdirSync(path.join(src, ".git"));
    fs.writeFileSync(path.join(src, ".git", "HEAD"), "x");
    fs.writeFileSync(path.join(src, "Thumbs.db"), "x");
    fs.writeFileSync(path.join(src, "mods", "a.jar"), aleatoire(10 * Kio));
    fs.writeFileSync(path.join(src, "mods", "sous", "b.jar"), aleatoire(400 * Kio)); // en morceaux
    fs.writeFileSync(path.join(src, "options.txt"), "texte");
    const file = new FileTransferts(client, { intervalle: 5 });
    let maxActives = 0;
    file.on("maj", (l) => (maxActives = Math.max(maxActives, l.filter((x) => x.etat === "encours" || x.etat === "preparation").length)));
    const finis = [];
    const fin = (n) => new Promise((ok) => file.on("fini", (e) => finis.push(e) === n && ok()));
    const attente = fin(3);
    file.ajouter({ sens: "envoi", titre: "pack", preparer: operations.preparerEnvoi([src], "") });
    file.ajouter({ sens: "envoi", titre: "petit", preparer: operations.preparerEnvoi([path.join(pc, "petit.bin")], "") });
    file.ajouter({ sens: "envoi", titre: "gros", preparer: operations.preparerEnvoi([path.join(pc, "gros.bin")], "copie") });
    await attente;
    assert.ok(finis.every((e) => e.etat === "fini"), JSON.stringify(file.liste().map((x) => [x.titre, x.etat, x.erreur])));
    assert.equal(maxActives, 2, "deux transferts à la fois au plus");
    assert.ok(fs.existsSync(path.join(racine, "pack", "vide")), "dossier vide recréé");
    assert.ok(!fs.existsSync(path.join(racine, "pack", ".git")));
    assert.ok(!fs.existsSync(path.join(racine, "pack", "Thumbs.db")));
    assert.ok(fs.readFileSync(path.join(racine, "pack", "mods", "sous", "b.jar")).equals(fs.readFileSync(path.join(src, "mods", "sous", "b.jar"))));
    const tache = file.liste().find((x) => x.titre === "pack");
    assert.equal(tache.fait, tache.total);

    const retour = path.join(tmp, "retour2");
    fs.mkdirSync(retour);
    const r = new Promise((ok) => file.once("fini", ok));
    file.ajouter({ sens: "telechargement", titre: "pack", preparer: operations.preparerTelechargement(client, [{ chemin: "pack", dossier: true }], retour) });
    assert.equal((await r).etat, "fini");
    assert.ok(fs.readFileSync(path.join(retour, "pack", "mods", "sous", "b.jar")).equals(fs.readFileSync(path.join(src, "mods", "sous", "b.jar"))));
    assert.equal(fs.readFileSync(path.join(retour, "pack", "options.txt"), "utf8"), "texte");
  });

  await t.test("file : annulation", async () => {
    const lent = await demarrer({ racine: path.join(tmp, "lent"), comptes: { equipe: "sésame" }, lenteur: 50 });
    const c = new Client({ ...options, base: lent.base });
    const file = new FileTransferts(c, { intervalle: 5 });
    const f = path.join(pc, "lent.bin");
    fs.writeFileSync(f, aleatoire(250 * Kio));
    const fini = new Promise((ok) => file.once("fini", ok));
    const id = file.ajouter({ sens: "envoi", titre: "lent", preparer: operations.preparerEnvoi([f], "") });
    await new Promise((ok) => setTimeout(ok, 100));
    assert.ok(file.annuler(id));
    assert.equal((await fini).etat, "annule");
    c.fermer();
    await lent.fermer();
  });

  await t.test("synchronisation : aperçu puis application", async () => {
    const loc = path.join(pc, "sync");
    fs.mkdirSync(path.join(loc, "mods"), { recursive: true });
    fs.writeFileSync(path.join(loc, "mods", "garde.jar"), "pareil");
    fs.writeFileSync(path.join(loc, "mods", "change.jar"), "nouveau!");
    fs.writeFileSync(path.join(loc, "mods", "neuf.jar"), "neuf");
    fs.writeFileSync(path.join(loc, "desktop.ini"), "x");
    fs.mkdirSync(path.join(racine, "cible", "mods"), { recursive: true });
    fs.mkdirSync(path.join(racine, "cible", "vieux", "sous"), { recursive: true });
    fs.writeFileSync(path.join(racine, "cible", "mods", "garde.jar"), "pareil");
    fs.writeFileSync(path.join(racine, "cible", "mods", "change.jar"), "ancien!!"); // même taille, autre contenu
    fs.writeFileSync(path.join(racine, "cible", "mods", "retire.jar"), "r");
    fs.writeFileSync(path.join(racine, "cible", "vieux", "sous", "x.txt"), "x");

    const etapes = [];
    const a = await operations.apercuSynchronisation(client, loc, "cible", { surEtape: (e) => etapes.push(e.etape) });
    assert.deepEqual(a.envoyer.map((f) => f.chemin), ["mods/neuf.jar"]);
    assert.deepEqual(a.remplacer.map((f) => f.chemin), ["mods/change.jar"], "empreinte SHA-1 différente");
    assert.deepEqual(a.supprimer.map((f) => f.chemin), ["mods/retire.jar", "vieux/sous/x.txt"]);
    assert.deepEqual(a.suppressions, ["mods/retire.jar", "vieux"]);
    assert.equal(a.identiques, 1);
    assert.ok(etapes.includes("Calcul des empreintes"));

    // Rien n'a encore changé sur le serveur : l'aperçu n'agit pas.
    assert.equal(fs.readFileSync(path.join(racine, "cible", "mods", "change.jar"), "utf8"), "ancien!!");

    const file = new FileTransferts(client, { intervalle: 5 });
    const fini = new Promise((ok) => file.once("fini", ok));
    file.ajouter({ sens: "sync", titre: "sync", preparer: operations.preparerSynchronisation(a) });
    assert.equal((await fini).etat, "fini");
    assert.equal(fs.readFileSync(path.join(racine, "cible", "mods", "change.jar"), "utf8"), "nouveau!");
    assert.ok(fs.existsSync(path.join(racine, "cible", "mods", "neuf.jar")));
    assert.ok(!fs.existsSync(path.join(racine, "cible", "mods", "retire.jar")));
    assert.ok(!fs.existsSync(path.join(racine, "cible", "vieux")));
    assert.ok(!fs.existsSync(path.join(racine, "cible", "desktop.ini")));

    const ensuite = await operations.apercuSynchronisation(client, loc, "cible");
    assert.equal(ensuite.envoyer.length + ensuite.remplacer.length + ensuite.supprimer.length, 0, "plus rien à faire");

    const sansSuppr = await operations.apercuSynchronisation(client, loc, "absent", { supprimer: false });
    assert.equal(sansSuppr.envoyer.length, 3, "dossier serveur absent : tout à envoyer");
  });
});
