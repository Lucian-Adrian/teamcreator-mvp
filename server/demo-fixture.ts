import { createHash, randomUUID } from 'node:crypto';
import type { ProjectProposal, ProjectRecord, ProjectSource, ProjectWorkspace, SourceRef } from '../shared/types.js';
import { streetlightSourcePack } from '../shared/demo-source-pack.js';

/** Build a source-cited, synthetic Bălți street-lighting presentation workspace. */
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
    processed_segments: [0],
    parse_coverage: 'complete',
    extraction_coverage: 'complete',
    extraction_note: 'Datele demonstrative sunt pregătite din sursele acestui proiect pentru revizie; nu reprezintă o rulare live a extragerii AI.',
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
  const radu = makeRecord({ kind: 'member', title: 'Radu Ionescu', role: 'Tehnician măsurători', member_type: 'person', documented_skills: ['Măsurători electrice', 'Verificări de teren'], availability_note: '3 zile/săptămână până la 16 octombrie 2026', source_refs: refs(ref(6, 2)), field_refs: { role: refs(ref(6, 2)), documented_skills: refs(ref(6, 2)), availability_note: refs(ref(6, 2)) } });
  const ioana = makeRecord({ kind: 'member', title: 'Ioana Popa', role: 'Coordonatoare documente', member_type: 'person', documented_skills: ['Control versiuni', 'Arhivare'], availability_note: '2 zile/săptămână până la 16 octombrie 2026', source_refs: refs(ref(6, 3)), field_refs: { role: refs(ref(6, 3)), documented_skills: refs(ref(6, 3)), availability_note: refs(ref(6, 3)) } });
  const oleg = makeRecord({ kind: 'member', title: 'Oleg Balan', role: 'Șef echipă teren', member_type: 'person', documented_skills: ['Instalare corpuri LED', 'Verificări după montaj'], availability_note: '3 zile/săptămână până la 16 octombrie 2026', source_refs: refs(ref(6, 4)), field_refs: { role: refs(ref(6, 4)), documented_skills: refs(ref(6, 4)), availability_note: refs(ref(6, 4)) } });
  members.push(sofia, andrei, dana, radu, ioana, oleg);
  for (const [member, skills, availability, line] of [
    [elena, ['Coordonare', 'Angajamente', 'Raportare'], '3 zile/săptămână până la 16 octombrie 2026', 2],
    [victor, ['Proiectare electrică', 'Scheme', 'Specificații'], '4 zile/săptămână până la 16 octombrie 2026', 3],
    [irina, ['Verificare tehnică', 'Comunicare cu beneficiarul'], '2 zile/săptămână până la 16 octombrie 2026', 4],
    [mihai, ['Achiziții', 'Comparație oferte'], '3 zile/săptămână până la 16 octombrie 2026', 5],
  ] as const) {
    member.documented_skills = [...skills]; member.availability_note = availability;
    member.source_refs.push(ref(5, line)); member.field_refs = { ...member.field_refs, documented_skills: refs(ref(5, line)), availability_note: refs(ref(5, line)) };
  }
  const collaborationProfiles = [
    [elena, 2, ['Coordonare', 'Raportare'], [[mihai, 'Elena preferă să primească raportul lui Mihai înaintea reviziei.']]],
    [victor, 3, ['Proiectare', 'Documentare'], [[irina, 'Victor preferă scheme versionate și întrebări de revizie grupate pentru Irina.']]],
    [irina, 4, ['Revizie tehnică', 'Comunicare'], [[victor, 'Irina preferă ca Victor să atașeze lista punctelor verificate la fiecare predare.']]],
    [mihai, 5, ['Achiziții', 'Urmărire furnizori'], [[elena, 'Mihai preferă să transmită Elenei statusul confirmării înainte de check-in.']]],
    [sofia, 6, ['Devize', 'Verificare materiale'], [[mihai, 'Sofia preferă să predea lui Mihai o listă cu abaterile marcate.']]],
    [andrei, 7, ['Organizare șantier', 'Securitate electrică'], [[irina, 'Andrei preferă să trimită Irinei planul de siguranță pentru revizie.']]],
    [dana, 8, ['Guvernanță', 'Bugete'], [[elena, 'Dana preferă să primească de la Elena două opțiuni și impactul lor înaintea unei decizii.']]],
    [radu, 9, ['Măsurători electrice', 'Verificări de teren'], [[sofia, 'Radu preferă să transmită Sofiei fișele de măsurători în aceeași zi.']]],
    [ioana, 10, ['Control versiuni', 'Arhivare'], [[victor, 'Ioana preferă să primească de la Victor versiunea tehnică acceptată înainte de arhivare.']]],
    [oleg, 11, ['Instalare LED', 'Verificări după montaj'], [[andrei, 'Oleg preferă să alinieze accesul la teren cu Andrei înainte de instalare.']]],
  ] as const;
  for (const [member, line, softSkills, compatibility] of collaborationProfiles) {
    const sourceRef = ref(8, line);
    member.collaboration_profile = {
      basis: 'declared',
      source_label: '09-collaboration-notes.md · declarații sintetice',
      recorded_on: '2026-09-27',
      soft_skills: [...softSkills],
      working_preferences: sourceRef.quote,
      psychometric_method: null,
      psychometric_summary: null,
      compatibility: compatibility.map(([other, note]) => ({ member_id: other.id, note })),
    };
    member.source_refs.push(sourceRef);
    member.field_refs = { ...member.field_refs, collaboration_profile: refs(sourceRef) };
  }
  const task = (fields: Partial<ProjectRecord> & Pick<ProjectRecord, 'id' | 'title'>) => makeRecord({ kind: 'task', ...fields });
  const plan = task({
    id: 't-01-intermediate-plan', title: 'Pregătește planul tehnic intermediar', owner: victor.title, owner_id: victor.id, status: 'in_progress', due: '2026-09-30', due_basis: 'reported',
    source_refs: refs(ref(1, 2), ref(4, 2)), field_refs: { owner: refs(ref(1, 2)), status: refs(ref(1, 2)), due: refs(ref(1, 2)) },
  });
  const technicalReview = task({
    id: 't-02-technical-review', title: 'Revizie tehnică a planului intermediar', owner: irina.title, owner_id: irina.id, status: 'not_started', due_basis: 'unknown', depends_on: [plan.id],
    source_refs: refs(ref(1, 3), ref(3, 5)), field_refs: { owner: refs(ref(1, 3)), status: refs(ref(1, 3)) }, dependency_refs: { [plan.id]: refs(ref(0, 9), ref(3, 5)) },
  });
  const beneficiaryApproval = task({
    id: 't-03-beneficiary-approval', title: 'Obține aprobarea beneficiarului', owner: irina.title, owner_id: irina.id, status: 'not_started', due_basis: 'unknown', depends_on: [technicalReview.id],
    source_refs: refs(ref(1, 4), ref(3, 6)), field_refs: { owner: refs(ref(1, 4)), status: refs(ref(1, 4)) }, dependency_refs: { [technicalReview.id]: refs(ref(0, 10), ref(3, 6)) },
  });
  const vendorDate = task({
    id: 't-04-confirm-vendor-date', title: 'Confirmă data livrării cu furnizorul', owner: mihai.title, owner_id: mihai.id, status: 'waiting_for_confirmation', due_basis: 'unknown',
    source_refs: refs(ref(1, 5), ref(2, 2), ref(2, 3), ref(3, 2)), field_refs: { owner: refs(ref(1, 5)), status: refs(ref(1, 5), ref(2, 2)) },
    description: 'Data nu este confirmată direct de furnizor în sursele disponibile. Starea este relatată de manager.',
  });
  const reviewVendorReply = task({
    id: 't-06-review-vendor-reply', title: 'Revizuiește data furnizorului la următorul check-in', owner: elena.title, owner_id: elena.id, status: 'waiting_for_confirmation', due_basis: 'unknown', depends_on: [vendorDate.id],
    source_refs: refs(ref(1, 7), ref(3, 4), ref(2, 4)), field_refs: { owner: refs(ref(1, 7)), status: refs(ref(1, 7)) }, dependency_refs: { [vendorDate.id]: refs(ref(1, 7), ref(3, 4)) },
  });
  const procurementPack = task({
    id: 't-05-procurement-pack', title: 'Pregătește dosarul de achiziție', owner: mihai.title, owner_id: mihai.id, status: 'not_started', due_basis: 'unknown', depends_on: [technicalReview.id],
    source_refs: refs(ref(1, 6), ref(4, 6)), field_refs: { owner: refs(ref(1, 6)), status: refs(ref(1, 6)) }, dependency_refs: { [technicalReview.id]: refs(ref(1, 6), ref(4, 6)) },
  });
  const tasks = [plan, technicalReview, beneficiaryApproval, vendorDate, reviewVendorReply, procurementPack];
  for (const [record, start, days, hours, line] of [
    [plan, '2026-09-28', 3, 16, 10],
    [technicalReview, '2026-10-01', 2, 8, 11],
    [beneficiaryApproval, '2026-10-06', 1, 3, 12],
    [procurementPack, '2026-10-05', 2, 8, 14],
  ] as const) {
    const sourceRef = ref(6, line);
    record.planned_start = start;
    record.planned_duration_days = days;
    record.effort_hours = hours;
    record.source_refs.push(sourceRef);
    record.field_refs = {
      ...record.field_refs,
      planned_start: refs(sourceRef),
      planned_duration_days: refs(sourceRef),
      effort_hours: refs(sourceRef),
    };
  }
  const detailed = [
    { id: 't-07-inventory', title: 'Verifică inventarul punctelor de iluminat', owner: sofia, status: 'complete', due: '2026-09-25', start: '2026-09-23', days: 2, hours: 12, deps: [], line: 9, completed: '2026-09-25', completionLine: 5 },
    { id: 't-08-materials', title: 'Verifică lista de materiale', owner: sofia, status: 'in_progress', due: '2026-10-02', start: '2026-10-01', days: 2, hours: 10, deps: [plan.id], line: 10 },
    { id: 't-09-offers', title: 'Compară ofertele tehnice', owner: mihai, status: 'not_started', due: '2026-10-06', start: '2026-10-05', days: 2, hours: 12, deps: [procurementPack.id, 't-08-materials'], line: 11 },
    { id: 't-10-capacity', title: 'Decide suplimentarea capacității', owner: dana, status: 'waiting', due: '2026-10-02', start: '2026-10-02', days: 1, hours: 2, deps: [reviewVendorReply.id], line: 12 },
    { id: 't-11-installation-plan', title: 'Pregătește planul de instalare', owner: andrei, status: 'not_started', due: '2026-10-09', start: '2026-10-07', days: 3, hours: 16, deps: [beneficiaryApproval.id, 't-09-offers'], line: 13 },
    { id: 't-12-safety', title: 'Revizuiește planul de siguranță', owner: irina, status: 'not_started', due: '2026-10-12', start: '2026-10-12', days: 1, hours: 4, deps: ['t-11-installation-plan'], line: 14 },
    { id: 't-13-client-report', title: 'Pregătește raportul pentru client', owner: elena, status: 'in_progress', due: '2026-10-05', start: '2026-10-05', days: 1, hours: 3, deps: [technicalReview.id], line: 15 },
    { id: 't-14-installation-window', title: 'Confirmă fereastra de instalare', owner: andrei, status: 'not_started', due: null, start: null, days: null, hours: null, deps: [vendorDate.id, 't-12-safety'], line: 16 },
    { id: 't-15-field-control-points', title: 'Marchează punctele de control pe teren', owner: sofia, status: 'complete', due: '2026-09-22', start: '2026-09-21', days: 1, hours: 5, deps: [], sourceIndex: 6, line: 5, completed: '2026-09-22', completionLine: 2 },
    { id: 't-16-measure-test-circuits', title: 'Măsoară circuitele de probă', owner: radu, status: 'complete', due: '2026-09-23', start: '2026-09-22', days: 1, hours: 7, deps: ['t-15-field-control-points'], sourceIndex: 6, line: 6, completed: '2026-09-23', completionLine: 3 },
    { id: 't-17-validate-locations', title: 'Validează coordonatele punctelor de lumină', owner: sofia, status: 'complete', due: '2026-09-24', start: '2026-09-23', days: 1, hours: 6, deps: ['t-15-field-control-points'], sourceIndex: 6, line: 7, completed: '2026-09-24', completionLine: 4 },
    { id: 't-18-offer-comparison-template', title: 'Pregătește modelul de comparație a ofertelor', owner: mihai, status: 'complete', due: '2026-09-26', start: '2026-09-25', days: 1, hours: 4, deps: [], sourceIndex: 6, line: 8, completed: '2026-09-26', completionLine: 6 },
    { id: 't-19-site-access', title: 'Verifică accesul pentru montaj', owner: andrei, status: 'not_started', due: '2026-10-19', start: '2026-10-16', days: 2, hours: 8, deps: ['t-11-installation-plan'], sourceIndex: 6, line: 9 },
    { id: 't-20-post-install-check', title: 'Verifică instalația după montaj', owner: oleg, status: 'not_started', due: '2026-10-21', start: '2026-10-20', days: 2, hours: 8, deps: ['t-12-safety', 't-19-site-access'], sourceIndex: 6, line: 10 },
  ];
  tasks.push(...detailed.map(item => task({ id: item.id, title: item.title, owner: item.owner.title, owner_id: item.owner.id, status: item.status,
    due: item.due, due_basis: item.due ? 'reported' : 'unknown', planned_start: item.start, planned_duration_days: item.days, effort_hours: item.hours,
    completed_at: item.completed || null, depends_on: item.deps, source_refs: refs(ref(item.sourceIndex ?? 5, item.line), ...(item.completionLine ? [ref(7, item.completionLine)] : [])),
    description: ref(item.sourceIndex ?? 5, item.line).quote, field_refs: Object.fromEntries([
      ...['owner', 'status', 'due', 'planned_start', 'planned_duration_days', 'effort_hours'].map(field => [field, refs(ref(item.sourceIndex ?? 5, item.line))]),
      ...(item.completionLine ? [['completed_at', refs(ref(7, item.completionLine))]] : []),
    ]),
    dependency_refs: Object.fromEntries(item.deps.map(id => [id, refs(ref(item.sourceIndex ?? 5, item.line))])),
  })));
  const deliverables = [
    makeRecord({ kind: 'deliverable', id: 'd-01-intermediate-plan', title: 'Plan tehnic intermediar', status: 'in_progress', owner: victor.title, owner_id: victor.id, due_basis: 'baseline', baseline_due: '2026-09-30', depends_on: [plan.id], source_refs: refs(ref(0, 7), ref(1, 8)), field_refs: { owner: refs(ref(0, 4)), baseline_due: refs(ref(0, 8), ref(1, 8)) }, dependency_refs: { [plan.id]: refs(ref(1, 8)) } }),
    makeRecord({ kind: 'deliverable', id: 'd-02-approved-pack', title: 'Pachet tehnic aprobat', status: 'not_started', owner: irina.title, owner_id: irina.id, due_basis: 'unknown', depends_on: [beneficiaryApproval.id], source_refs: refs(ref(1, 9), ref(0, 10)), field_refs: { owner: refs(ref(1, 4)) }, dependency_refs: { [beneficiaryApproval.id]: refs(ref(1, 9)) } }),
    makeRecord({ kind: 'deliverable', id: 'd-03-post-install-checklist', title: 'Fișă de verificare după montaj', status: 'planned', owner: oleg.title, owner_id: oleg.id, due: '2026-10-22', due_basis: 'reported', planned_start: '2026-10-22', source_refs: refs(ref(6, 17)), field_refs: { owner: refs(ref(6, 17)), due: refs(ref(6, 17)), planned_start: refs(ref(6, 17)) }, depends_on: ['t-20-post-install-check'], dependency_refs: { 't-20-post-install-check': refs(ref(6, 17)) } }),
  ];
  const risks = [
    makeRecord({ kind: 'risk', id: 'r-01-vendor-date', title: 'Data de livrare a echipamentelor nu este confirmată', status: 'needs_confirmation', owner: mihai.title, owner_id: mihai.id, evidence_state: 'supported', review_state: 'unreviewed', source_refs: refs(ref(2, 2), ref(2, 3)), field_refs: { status: refs(ref(2, 2)), owner: refs(ref(2, 4)) }, description: 'Relatarea managerului indică lipsa confirmării; sursa directă a furnizorului lipsește.' }),
    makeRecord({ kind: 'risk', id: 'r-02-approval-window', title: 'Termenul aprobării beneficiarului nu este consemnat', status: 'needs_confirmation', owner: irina.title, owner_id: irina.id, evidence_state: 'supported', review_state: 'unreviewed', source_refs: refs(ref(6, 18)), field_refs: { status: refs(ref(6, 18)), owner: refs(ref(6, 18)) }, description: 'Durata pentru aprobare din preset este o ipoteză editabilă; calendarul beneficiarului nu este confirmat.' }),
    makeRecord({ kind: 'risk', id: 'r-03-site-access', title: 'Fereastra de acces la teren nu este confirmată', status: 'needs_confirmation', owner: andrei.title, owner_id: andrei.id, evidence_state: 'supported', review_state: 'unreviewed', source_refs: refs(ref(6, 19)), field_refs: { status: refs(ref(6, 19)), owner: refs(ref(6, 19)) }, description: 'Accesul la zonele de montaj trebuie confirmat înainte de programarea echipei.' }),
  ];
  const decisions = [
    makeRecord({ kind: 'decision', id: 'dc-01-intermediate-delivery', title: 'Cere data furnizorului și clarifică livrabilul intermediar', status: 'recommended_question', evidence_state: 'derived_by_rule', review_state: 'unreviewed', owner: elena.title, owner_id: elena.id, source_refs: refs(ref(2, 2), ref(2, 5), ref(0, 11)), description: 'Întrebare de lucru: „Până când puteți confirma data echipamentelor și ce rezultat tehnic intermediar putem transmite înaintea versiunii finale?” Nu a fost trimisă și nu este o decizie înregistrată.' }),
    makeRecord({ kind: 'decision', id: 'dc-02-approval-window', title: 'Confirmă calendarul aprobării beneficiarului', status: 'recommended_question', evidence_state: 'derived_by_rule', review_state: 'unreviewed', owner: elena.title, owner_id: elena.id, source_refs: refs(ref(6, 18)), description: 'Întrebare de pregătire: ce termen de revizie și aprobare poate confirma beneficiarul? Nu a fost trimisă.' }),
    makeRecord({ kind: 'decision', id: 'dc-03-site-access', title: 'Confirmă fereastra de acces pentru montaj', status: 'recommended_question', evidence_state: 'derived_by_rule', review_state: 'unreviewed', owner: andrei.title, owner_id: andrei.id, source_refs: refs(ref(6, 19), ref(9, 2)), description: 'Întrebare de pregătire: ce interval de acces poate fi confirmat pentru echipa de teren? Nu a fost trimisă.' }),
  ];

  const proposals: ProjectProposal[] = [{
    id: 'pr-presentation-options', project_id: projectId, title: 'Opțiuni de planificare pentru revizia PM',
    summary: 'Două opțiuni sintetice și neaprobate din sursa de prezentare; registrul curent rămâne neschimbat până la revizie.',
    status: 'proposed', source_ids: [sourceIds[9], sourceIds[6]],
    items: [
      { id: 'pr-item-t14-window', operation: 'update', record_kind: 'task', record_id: 't-14-installation-window', title: 'Propune fereastră provizorie pentru instalare', fields: { planned_start: '2026-10-15', planned_duration_days: 1, effort_hours: 2 }, before: { planned_start: null, planned_duration_days: null, effort_hours: null }, source_refs: refs(ref(9, 2)), consequential: true, review_state: 'unreviewed' },
      { id: 'pr-item-post-install-check', operation: 'create', record_kind: 'task', record_id: null, title: 'Verifică iluminarea după montaj', fields: { kind: 'task', title: 'Verifică iluminarea după montaj', status: 'not_started', owner: oleg.title, owner_id: oleg.id, due: '2026-10-22', due_basis: 'forecast', planned_start: '2026-10-22', planned_duration_days: 1, effort_hours: 4, depends_on: ['t-20-post-install-check'] }, before: null, source_refs: refs(ref(9, 3), ref(6, 10)), consequential: true, review_state: 'unreviewed' },
    ],
    conflicts: [], missing_info: ['Confirmarea PM pentru fereastra de acces și includerea verificării după montaj.'], provider_mode: 'degraded', provider_model: null, created_at: timestamp,
  }];
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
    { id: randomUUID(), project_id: projectId, type: 'project_created' as const, actor: 'local manager', at: timestamp, summary: 'Synthetic street-lighting presentation workspace created from ten demonstration sources.' },
    { id: randomUUID(), project_id: projectId, type: 'source_added' as const, actor: 'local manager', at: timestamp, summary: 'Ten curated synthetic project sources are available for evidence review; no live extraction is claimed.', source_ids: sourceIds },
  ];
  const changes = [
    { id: randomUUID(), project_id: projectId, at: timestamp, type: 'project_created', title: 'Demonstrație completă pregătită', summary: 'Zece persoane fictive, 20 de sarcini, livrabile, predări, profiluri declarate, riscuri și decizii de revizuit.', source_refs: [], review_state: 'manager_confirmed' as const },
    { id: randomUUID(), project_id: projectId, at: timestamp, type: 'reported_unknown', title: 'Data furnizorului așteaptă confirmare', summary: 'Nota atribuie această informație relatării managerului; mesajul furnizorului nu este inclus.', source_refs: refs(ref(2, 2), ref(2, 3)), review_state: 'manager_confirmed' as const },
    { id: randomUUID(), project_id: projectId, at: timestamp, type: 'documented_handoff', title: 'Planul intermediar trece la revizia tehnică', summary: 'Legătura dintre sarcini are citat și poate fi deschisă din hartă.', source_refs: refs(ref(3, 5)), review_state: 'manager_confirmed' as const },
  ];

  return {
    project: {
      id: projectId,
      name: 'Iluminat stradal · Bălți · prezentare',
      created_at: timestamp,
      updated_at: timestamp,
      synthetic: true,
      description: 'Demonstrație completă · date, roluri și relații fictive · versiunea 2026-09-27.3.',
    },
    members,
    tasks,
    deliverables,
    risks,
    decisions,
    dependencies,
    assignments,
    sources,
    proposals,
    changes,
    audit,
    graph: { cycles: [], has_cycles: false },
  };
}
