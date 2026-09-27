import { createHash, randomUUID } from 'node:crypto';
import type { ProjectRecord, ProjectSource, ProjectWorkspace, SourceRef } from '../shared/types.js';
import { streetlightSourcePack } from '../shared/demo-source-pack.js';

/** Build a source-cited synthetic Bălți street-lighting walkthrough. */
export function buildSyntheticDemoWorkspace(projectId: string, timestamp: string): ProjectWorkspace {
  const sourceIds = streetlightSourcePack.map(() => randomUUID());
  const sources: ProjectSource[] = streetlightSourcePack.map((item, index) => ({
    id: sourceIds[index],
    name: item.name,
    relative_path: item.name,
    sha256: createHash('sha256').update(item.text).digest('hex'),
    size: Buffer.byteLength(item.text),
    media_type: item.mediaType,
    parser_status: 'parsed',
    parsed_text_characters: item.text.length,
    segments_total: 1,
    processed_segments: [],
    parse_coverage: 'complete',
    extraction_coverage: 'unavailable',
    extraction_note: 'Synthetic walkthrough source. Codex extraction was not run for this prebuilt visual sample.',
    fixture_only: true,
    created_at: timestamp,
    excerpt: item.text,
  }));
  const sourceLines = streetlightSourcePack.map((item) => item.text.split('\n'));
  const ref = (sourceIndex: number, line: number): SourceRef => ({
    source_id: sourceIds[sourceIndex],
    location: `line ${line}`,
    quote: sourceLines[sourceIndex][line - 1] || '',
  });
  const refs = (...items: SourceRef[]) => items;
  const makeRecord = (fields: Partial<ProjectRecord> & Pick<ProjectRecord, 'kind' | 'title'>): ProjectRecord => {
    const { id: recordId, kind, title, ...otherFields } = fields;
    return {
    id: recordId || randomUUID(),
    kind,
    title,
    status: null,
    owner: null,
    owner_id: null,
    due: null,
    due_basis: 'unknown',
    completed_at: null,
    baseline_due: null,
    current_forecast: null,
    depends_on: [],
    source_refs: [],
    field_refs: {},
    evidence_state: 'supported',
    review_state: 'manager_confirmed',
    created_at: timestamp,
    updated_at: timestamp,
    ...otherFields,
  };
  };

  const portrait = '/brand/streetlight-team.png';
  const members = [
    makeRecord({ kind: 'member', title: 'Elena Rusu', role: 'Manager de proiect', member_type: 'person', avatar_asset: portrait, avatar_crop: 'top-left', avatar_is_illustrative: true, source_refs: refs(ref(0, 3), ref(3, 2)), field_refs: { role: refs(ref(0, 3)), member_type: refs(ref(0, 3)) } }),
    makeRecord({ kind: 'member', title: 'Victor Munteanu', role: 'Inginer proiectare', member_type: 'person', avatar_asset: portrait, avatar_crop: 'top-right', avatar_is_illustrative: true, source_refs: refs(ref(0, 4), ref(1, 2)), field_refs: { role: refs(ref(0, 4)), member_type: refs(ref(0, 4)) } }),
    makeRecord({ kind: 'member', title: 'Irina Ceban', role: 'Revizie tehnică · beneficiar', member_type: 'person', avatar_asset: portrait, avatar_crop: 'bottom-left', avatar_is_illustrative: true, source_refs: refs(ref(0, 5), ref(1, 3)), field_refs: { role: refs(ref(0, 5)), member_type: refs(ref(0, 5)) } }),
    makeRecord({ kind: 'member', title: 'Mihai Lungu', role: 'Coordonator aprovizionare', member_type: 'person', avatar_asset: portrait, avatar_crop: 'bottom-right', avatar_is_illustrative: true, source_refs: refs(ref(0, 6), ref(2, 4)), field_refs: { role: refs(ref(0, 6)), member_type: refs(ref(0, 6)) } }),
  ];
  const [elena, victor, irina, mihai] = members;
  const sofia = makeRecord({ kind: 'member', title: 'Sofia Dinu', role: 'Verificare cantități', member_type: 'person', documented_skills: ['Devize', 'Liste de materiale'], availability_note: '2 zile/săptămână până la 16 octombrie 2026, declarație sintetică', source_refs: refs(ref(5, 6)), field_refs: { role: refs(ref(5, 6)), documented_skills: refs(ref(5, 6)), availability_note: refs(ref(5, 6)) } });
  const andrei = makeRecord({ kind: 'member', title: 'Andrei Rotaru', role: 'Coordonator instalare', member_type: 'person', documented_skills: ['Organizare șantier', 'Securitate electrică'], availability_note: 'Disponibilitate pentru execuție neconfirmată', source_refs: refs(ref(5, 7)), field_refs: { role: refs(ref(5, 7)), documented_skills: refs(ref(5, 7)), availability_note: refs(ref(5, 7)) } });
  const dana = makeRecord({ kind: 'member', title: 'Dana Moraru', role: 'Sponsor · resurse și scop', member_type: 'person', documented_skills: ['Guvernanță', 'Bugete'], availability_note: 'Interval pentru decizii neconfirmat', source_refs: refs(ref(5, 8)), field_refs: { role: refs(ref(5, 8)), documented_skills: refs(ref(5, 8)), availability_note: refs(ref(5, 8)) } });
  members.push(sofia, andrei, dana);
  for (const [member, skills, availability, line] of [
    [elena, ['Coordonare', 'Angajamente', 'Raportare'], '3 zile/săptămână până la 16 octombrie 2026', 2],
    [victor, ['Proiectare electrică', 'Scheme', 'Specificații'], '4 zile/săptămână până la 16 octombrie 2026', 3],
    [irina, ['Verificare tehnică', 'Comunicare cu beneficiarul'], '2 zile/săptămână până la 16 octombrie 2026', 4],
    [mihai, ['Achiziții', 'Comparație oferte'], '3 zile/săptămână până la 16 octombrie 2026', 5],
  ] as const) {
    member.documented_skills = [...skills]; member.availability_note = availability;
    member.source_refs.push(ref(5, line)); member.field_refs = { ...member.field_refs, documented_skills: refs(ref(5, line)), availability_note: refs(ref(5, line)) };
  }
  const task = (fields: Partial<ProjectRecord> & Pick<ProjectRecord, 'id' | 'title'>) => makeRecord({ kind: 'task', ...fields });
  const plan = task({
    id: 't-01-intermediate-plan', title: 'Pregătește planul tehnic intermediar', owner: victor.title, owner_id: victor.id, status: 'in_progress', due: '2026-09-30', due_basis: 'reported',
    source_refs: refs(ref(1, 2), ref(4, 2)), field_refs: { owner: refs(ref(1, 2)), status: refs(ref(1, 2)), due: refs(ref(1, 2)) },
  });
  const technicalReview = task({
    id: 't-02-technical-review', title: 'Revizie tehnică a planului', owner: irina.title, owner_id: irina.id, status: 'not_started', due_basis: 'unknown', depends_on: [plan.id],
    source_refs: refs(ref(1, 3), ref(3, 5)), field_refs: { owner: refs(ref(1, 3)), status: refs(ref(1, 3)) }, dependency_refs: { [plan.id]: refs(ref(0, 9), ref(3, 5)) },
  });
  const beneficiaryApproval = task({
    id: 't-03-beneficiary-approval', title: 'Coordonează aprobarea beneficiarului', owner: irina.title, owner_id: irina.id, status: 'not_started', due_basis: 'unknown', depends_on: [technicalReview.id],
    source_refs: refs(ref(1, 4), ref(3, 6)), field_refs: { owner: refs(ref(1, 4)), status: refs(ref(1, 4)) }, dependency_refs: { [technicalReview.id]: refs(ref(0, 10), ref(3, 6)) },
  });
  const vendorDate = task({
    id: 't-04-confirm-vendor-date', title: 'Confirmă data livrării cu furnizorul', owner: mihai.title, owner_id: mihai.id, status: 'waiting_for_confirmation', due_basis: 'unknown',
    source_refs: refs(ref(1, 5), ref(2, 2), ref(2, 3), ref(3, 2)), field_refs: { owner: refs(ref(1, 5)), status: refs(ref(1, 5), ref(2, 2)) },
    description: 'Data nu este confirmată direct de furnizor în sursele disponibile. Starea este relatată de manager.',
  });
  const reviewVendorReply = task({
    id: 't-06-review-vendor-reply', title: 'Revizuiește răspunsul furnizorului', owner: elena.title, owner_id: elena.id, status: 'waiting_for_confirmation', due_basis: 'unknown', depends_on: [vendorDate.id],
    source_refs: refs(ref(1, 7), ref(3, 4), ref(2, 4)), field_refs: { owner: refs(ref(1, 7)), status: refs(ref(1, 7)) }, dependency_refs: { [vendorDate.id]: refs(ref(1, 7), ref(3, 4)) },
  });
  const procurementPack = task({
    id: 't-05-procurement-pack', title: 'Pregătește dosarul de achiziție', owner: mihai.title, owner_id: mihai.id, status: 'not_started', due_basis: 'unknown', depends_on: [technicalReview.id],
    source_refs: refs(ref(1, 6), ref(4, 6)), field_refs: { owner: refs(ref(1, 6)), status: refs(ref(1, 6)) }, dependency_refs: { [technicalReview.id]: refs(ref(1, 6), ref(4, 6)) },
  });
  const tasks = [plan, technicalReview, beneficiaryApproval, vendorDate, reviewVendorReply, procurementPack];
  const detailed = [
    { id: 't-07-inventory', title: 'Verifică inventarul punctelor de iluminat', owner: sofia, status: 'complete', due: '2026-09-25', start: '2026-09-23', days: 2, hours: 12, deps: [], line: 9, completed: '2026-09-25' },
    { id: 't-08-materials', title: 'Verifică lista de materiale', owner: sofia, status: 'in_progress', due: '2026-10-02', start: '2026-10-01', days: 2, hours: 10, deps: [plan.id], line: 10 },
    { id: 't-09-offers', title: 'Compară ofertele tehnice', owner: mihai, status: 'not_started', due: '2026-10-06', start: '2026-10-05', days: 2, hours: 12, deps: [procurementPack.id, 't-08-materials'], line: 11 },
    { id: 't-10-capacity', title: 'Decide suplimentarea capacității', owner: dana, status: 'waiting', due: '2026-10-02', start: '2026-10-02', days: 1, hours: 2, deps: [reviewVendorReply.id], line: 12 },
    { id: 't-11-installation-plan', title: 'Pregătește planul de instalare', owner: andrei, status: 'not_started', due: '2026-10-09', start: '2026-10-07', days: 3, hours: 16, deps: [beneficiaryApproval.id, 't-09-offers'], line: 13 },
    { id: 't-12-safety', title: 'Revizuiește planul de siguranță', owner: irina, status: 'not_started', due: '2026-10-12', start: '2026-10-12', days: 1, hours: 4, deps: ['t-11-installation-plan'], line: 14 },
    { id: 't-13-client-report', title: 'Pregătește raportul pentru client', owner: elena, status: 'in_progress', due: '2026-10-05', start: '2026-10-05', days: 1, hours: 3, deps: [technicalReview.id], line: 15 },
    { id: 't-14-installation-window', title: 'Confirmă fereastra de instalare', owner: andrei, status: 'not_started', due: null, start: null, days: null, hours: null, deps: [vendorDate.id, 't-12-safety'], line: 16 },
  ];
  tasks.push(...detailed.map(item => task({ id: item.id, title: item.title, owner: item.owner.title, owner_id: item.owner.id, status: item.status,
    due: item.due, due_basis: item.due ? 'reported' : 'unknown', planned_start: item.start, planned_duration_days: item.days, effort_hours: item.hours,
    completed_at: item.completed || null, depends_on: item.deps, source_refs: refs(ref(5, item.line)),
    description: ref(5, item.line).quote, field_refs: Object.fromEntries(['owner', 'status', 'due', 'planned_start', 'planned_duration_days', 'effort_hours'].map(field => [field, refs(ref(5, item.line))])),
    dependency_refs: Object.fromEntries(item.deps.map(id => [id, refs(ref(5, item.line))])),
  })));
  const deliverables = [
    makeRecord({ kind: 'deliverable', id: 'd-01-intermediate-plan', title: 'Plan tehnic intermediar', status: 'in_progress', owner: victor.title, owner_id: victor.id, due_basis: 'baseline', baseline_due: '2026-09-30', depends_on: [plan.id], source_refs: refs(ref(0, 7), ref(1, 8)), field_refs: { owner: refs(ref(0, 4)), baseline_due: refs(ref(0, 8), ref(1, 8)) }, dependency_refs: { [plan.id]: refs(ref(1, 8)) } }),
    makeRecord({ kind: 'deliverable', id: 'd-02-approved-pack', title: 'Pachet tehnic aprobat', status: 'not_started', owner: irina.title, owner_id: irina.id, due_basis: 'unknown', depends_on: [beneficiaryApproval.id], source_refs: refs(ref(1, 9), ref(0, 10)), field_refs: { owner: refs(ref(1, 4)) }, dependency_refs: { [beneficiaryApproval.id]: refs(ref(1, 9)) } }),
  ];
  const risks = [
    makeRecord({ kind: 'risk', id: 'r-01-vendor-date', title: 'Data de livrare a echipamentelor nu este confirmată', status: 'needs_confirmation', owner: mihai.title, owner_id: mihai.id, evidence_state: 'supported', review_state: 'unreviewed', source_refs: refs(ref(2, 2), ref(2, 3)), field_refs: { status: refs(ref(2, 2)), owner: refs(ref(2, 4)) }, description: 'Relatarea managerului indică lipsa confirmării; sursa directă a furnizorului lipsește.' }),
  ];
  const decisions = [
    makeRecord({ kind: 'decision', id: 'dc-01-intermediate-delivery', title: 'Cere data furnizorului și clarifică livrabilul intermediar', status: 'recommended_question', evidence_state: 'derived_by_rule', review_state: 'unreviewed', owner: elena.title, owner_id: elena.id, source_refs: refs(ref(2, 2), ref(2, 5), ref(0, 11)), description: 'Întrebare de lucru: „Până când puteți confirma data echipamentelor și ce rezultat tehnic intermediar putem transmite înaintea versiunii finale?” Nu a fost trimisă și nu este o decizie înregistrată.' }),
  ];
  const records = [...members, ...tasks, ...deliverables];
  const dependencies = records.flatMap((record) => record.depends_on.map((prerequisiteId) => ({
    id: `${record.id}:${prerequisiteId}`,
    from_id: record.id,
    to_id: prerequisiteId,
    evidence_state: record.dependency_refs?.[prerequisiteId]?.length ? 'supported' as const : 'expert_observation' as const,
    source_refs: record.dependency_refs?.[prerequisiteId] || [],
  })));
  const assignments = records.flatMap((record) => {
    const member = record.owner_id ? members.find((candidate) => candidate.id === record.owner_id) : undefined;
    return member ? [{ id: `${record.id}:${member.id}`, record_id: record.id, member_id: member.id, evidence_state: record.field_refs?.owner?.length ? 'supported' as const : 'derived_by_rule' as const, source_refs: record.field_refs?.owner || [] }] : [];
  });
  const audit = [
    { id: randomUUID(), project_id: projectId, type: 'project_created' as const, actor: 'local manager', at: timestamp, summary: 'Synthetic street-lighting walkthrough created from six demonstration sources.' },
    { id: randomUUID(), project_id: projectId, type: 'source_added' as const, actor: 'local manager', at: timestamp, summary: 'Six synthetic source records added for the project map walkthrough.', source_ids: sourceIds },
  ];
  const changes = [
    { id: randomUUID(), project_id: projectId, at: timestamp, type: 'project_created', title: 'Scenariu demonstrativ gata', summary: 'Șapte persoane fictive, 14 sarcini, predări și aprobări, cu date necunoscute păstrate vizibil.', source_refs: [], review_state: 'manager_confirmed' as const },
    { id: randomUUID(), project_id: projectId, at: timestamp, type: 'reported_unknown', title: 'Data furnizorului așteaptă confirmare', summary: 'Nota atribuie această informație relatării managerului; mesajul furnizorului nu este inclus.', source_refs: refs(ref(2, 2), ref(2, 3)), review_state: 'manager_confirmed' as const },
    { id: randomUUID(), project_id: projectId, at: timestamp, type: 'documented_handoff', title: 'Planul intermediar trece la revizia tehnică', summary: 'Legătura dintre sarcini are citat și poate fi deschisă din hartă.', source_refs: refs(ref(3, 5)), review_state: 'manager_confirmed' as const },
  ];

  return {
    project: {
      id: projectId,
      name: 'Iluminat stradal · Bălți',
      created_at: timestamp,
      updated_at: timestamp,
      synthetic: true,
      description: 'Scenariu demonstrativ sintetic. Numele, rolurile, datele și relațiile sunt fictive; nu sunt extrase din documente de client.',
    },
    members,
    tasks,
    deliverables,
    risks,
    decisions,
    dependencies,
    assignments,
    sources,
    proposals: [],
    changes,
    audit,
    graph: { cycles: [], has_cycles: false },
  };
}
