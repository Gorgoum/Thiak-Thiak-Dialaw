"""
Importe les lieux d'Overture Maps (données ouvertes : CDLA-Permissive-2.0 / ODbL selon la source)
autour de Yène et les écrit dans data/lieux-overture.json.

Prérequis : Python 3 et DuckDB  (pip install duckdb)
Usage     : python scripts/importer-overture.py [version]   (ex : 2026-10-21.0 ; par défaut la plus récente)
Ensuite   : npm run init-db   pour charger les lieux dans la base.
"""
import json
import os
import re
import sys
import urllib.request

import duckdb

# Zone : Yène, Tode, Nditakh, Nianghal, Toubab Dialaw, Ndayane, Cap Rouge
XMIN, XMAX, YMIN, YMAX = -17.24, -17.08, 14.55, 14.70
CONFIANCE_MIN = 0.4

# Catégories Overture → catégories de l'application
def categorie(cat):
    c = (cat or '').lower()
    if re.search(r'worship|mosque|church', c): return 'culte'
    if re.search(r'school|learning|education|college|university|kindergarten', c): return 'ecole'
    if re.search(r'hospital|clinic|pharmacy|health|medical|doctor|dentist', c): return 'sante'
    if re.search(r'market', c): return 'marche'
    if re.search(r'store|shop|restaurant|eatery|bakery|food|cafe|bar|beverage|gas_station|financial|bank|service|hotel|lodging|bed_and_breakfast', c): return 'commerce'
    return 'autre'


def derniere_version():
    url = 'https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/'
    xml = urllib.request.urlopen(url, timeout=30).read().decode()
    versions = sorted(re.findall(r'<Prefix>release/([^/<]+)/</Prefix>', xml))
    return versions[-1]


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else derniere_version()
    print('Overture Maps, version', version, '(lecture distante, quelques minutes)')
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    lignes = con.execute(f"""
        SELECT id, names.primary, coalesce(basic_category, taxonomy.primary),
               ST_Y(geometry), ST_X(geometry), confidence, operating_status
        FROM read_parquet('s3://overturemaps-us-west-2/release/{version}/theme=places/type=place/*', hive_partitioning=1)
        WHERE bbox.xmin BETWEEN {XMIN} AND {XMAX} AND bbox.ymin BETWEEN {YMIN} AND {YMAX}
    """).fetchall()

    lieux = []
    for id_, nom, cat, lat, lng, conf, statut in lignes:
        nom = (nom or '').strip()
        if not nom or (conf or 0) < CONFIANCE_MIN or (statut or '').startswith('closed'):
            continue
        lieux.append({'osm_id': 'overture/' + id_, 'nom': nom, 'categorie': categorie(cat),
                      'lat': round(lat, 6), 'lng': round(lng, 6)})
    lieux.sort(key=lambda l: l['nom'].lower())

    sortie = os.path.join(os.path.dirname(__file__), '..', 'data', 'lieux-overture.json')
    with open(sortie, 'w', encoding='utf-8') as f:
        json.dump(lieux, f, ensure_ascii=False, indent=1)
    print(len(lieux), 'lieux ->', os.path.normpath(sortie))


if __name__ == '__main__':
    main()
