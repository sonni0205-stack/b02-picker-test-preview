/* B02 read-only Google Picker probe. Never persist or log credentials/content. */
(() => {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER = 'application/vnd.google-apps.folder';
  const $ = id => document.getElementById(id);
  let accessToken = null;
  let selected = new Map();
  let activeConfig = null;
  let pickerReady = false;
  let busy = false;
  const status = message => { $('result').textContent = message; };
  const fail = message => { status('중단: ' + message); };
  const id = value => /^[A-Za-z0-9_-]{10,100}$/.test(value);
  const config = () => {
    const c = Object.fromEntries(['client', 'key', 'app', 'root', 'ready', 'ledger'].map(k => [k, $(k).value.trim()]));
    if (!/^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/.test(c.client) ||
        !/^AIza[A-Za-z0-9_-]{20,}$/.test(c.key) || !/^[0-9]{6,}$/.test(c.app) ||
        !['root', 'ready', 'ledger'].every(k => id(c[k])) ||
        new Set([c.root, c.ready, c.ledger]).size !== 3) throw Error('클라이언트 ID·제한 API 키·프로젝트 번호·서로 다른 폴더 ID를 확인하세요.');
    return c;
  };
  const currentConfig = () => {
    try {
      const c = config();
      return activeConfig && Object.keys(c).every(k => c[k] === activeConfig[k]) ? c : null;
    } catch (_) { return null; }
  };
  function updateReadButtons() {
    const c = currentConfig();
    $('read').disabled = busy || !accessToken || !c ||
      !['root', 'ready', 'ledger'].every(k => selected.get(k) === c[k]);
    $('read-child').disabled = busy || !accessToken || !c || !id(selected.get('child'));
  }
  const ready = () => Boolean(window.google?.accounts?.oauth2 && window.google?.picker && pickerReady);
  function startPicker() {
    if (busy) return;
    if (!ready()) return fail('Google 라이브러리를 아직 사용할 수 없습니다.');
    let c;
    try { c = config(); } catch (e) { return fail(e.message); }
    if (activeConfig && Object.keys(c).some(k => c[k] !== activeConfig[k]))
      return fail('연결 중 입력값이 바뀌었습니다. 토큰을 지운 뒤 다시 시작하세요.');
    const target = $('target').value;
    busy = true;
    const showPicker = () => {
      busy = false;
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true).setSelectFolderEnabled(true)
        .setMode(google.picker.DocsViewMode.LIST);
      if (target === 'child') view.setParent(c.ready);
      const picker = new google.picker.PickerBuilder().addView(view)
        .setOAuthToken(accessToken).setDeveloperKey(c.key).setAppId(c.app)
        .setOrigin(location.origin).setCallback(data => {
          if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) return;
          const docs = data[google.picker.Response.DOCUMENTS] || [];
          const chosen = docs.length === 1 && docs[0][google.picker.Document.ID];
          if (target === 'child') {
            if (!id(chosen) || [c.root, c.ready, c.ledger].includes(chosen))
              return fail('READY 하위 폴더를 선택하지 않았습니다.');
            selected.set('child', chosen); // This ID stays in memory; never render or persist it.
            updateReadButtons();
            return status('READY 하위 폴더 선택 결과를 받았습니다. 접근 권한은 아직 미검증입니다.');
          }
          if (chosen !== c[target]) return fail('선택한 폴더가 입력한 B02 대상 ID와 다릅니다.');
          selected.set(target, chosen);
          updateReadButtons();
          status(`${target} 폴더 선택 콜백을 받았습니다. 아직 Drive API 접근은 미검증입니다. 읽기 검사를 누르세요.`);
        }).build();
      picker.setVisible(true);
    };
    if (accessToken) return showPicker();
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: c.client, scope: SCOPE, include_granted_scopes: false,
      callback: response => {
        busy = false;
        if (response.error || !response.access_token ||
            !google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE) ||
            response.scope?.trim() !== SCOPE) return fail('drive.file 단일 권한의 새 액세스 토큰을 받지 못했습니다.');
        accessToken = response.access_token;
        activeConfig = c;
        selected.clear();
        updateReadButtons();
        showPicker();
      }
    });
    tokenClient.requestAccessToken({prompt: 'consent'});
  }
  async function drive(path, query = {}) {
    if (!accessToken) throw Error('이 탭의 새 OAuth 토큰이 없습니다.');
    const url = new URL('https://www.googleapis.com/drive/v3/' + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await fetch(url, {headers: {Authorization: `Bearer ${accessToken}`}, cache: 'no-store'});
    if (!response.ok) throw Error(`새 OAuth Drive API 읽기 실패 (HTTP ${response.status}). 토큰·선택 항목의 접근 권한을 확인하세요.`);
    return response;
  }
  async function meta(fileId) {
    return (await (await drive('files/' + encodeURIComponent(fileId),
      {fields: 'id,name,mimeType,parents,size,isAppAuthorized,capabilities(canListChildren)'})).json());
  }
  async function children(parentId) {
    const rows = [];
    let pageToken = '';
    do {
      const params = {q: `'${parentId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,parents,size)', pageSize: '100'};
      if (pageToken) params.pageToken = pageToken;
      const page = await (await drive('files', params)).json();
      rows.push(...(page.files || []));
      pageToken = page.nextPageToken || '';
      if (rows.length > 1000) throw Error('목록이 예상보다 큽니다. 안전을 위해 중단했습니다.');
    } while (pageToken);
    return rows;
  }
  async function readSelected() {
    if (busy) return;
    busy = true;
    $('read').disabled = true;
    try {
      const c = config();
      if (!currentConfig() || !['root', 'ready', 'ledger'].every(k => selected.get(k) === c[k]))
        throw Error('root·READY·발행기록 폴더를 각각 Picker에서 선택해야 합니다.');
      const folders = {};
      for (const k of ['root', 'ready', 'ledger']) {
        const f = await meta(c[k]);
        if (f.id !== c[k] || f.mimeType !== FOLDER) throw Error(`${k} 폴더 메타데이터가 일치하지 않습니다.`);
        folders[k] = f;
      }
      if (!folders.ready.parents?.includes(c.root) || !folders.ledger.parents?.includes(c.root))
        throw Error('READY 또는 발행기록 폴더가 지정한 B02 root 아래에 있지 않습니다.');
      const readyItems = await children(c.ready);
      if (!readyItems.length) throw Error('READY 목록이 0건입니다. drive.file이 기존 항목을 숨길 수 있어 비어 있다고 판단할 수 없습니다.');
      if (readyItems.length !== 1 || readyItems[0].mimeType !== FOLDER)
        throw Error('READY 패키지 폴더가 정확히 1개인지 확인되지 않았습니다.');
      const packageFolder = await meta(readyItems[0].id);
      if (!packageFolder.parents?.includes(c.ready)) throw Error('READY 패키지의 부모가 일치하지 않습니다.');
      const files = await children(packageFolder.id);
      const names = files.map(f => f.name);
      if (!['post.json', 'review.json', 'manifest.json'].every(n => names.includes(n)) ||
          files.filter(f => f.name.toLowerCase().endsWith('.png')).length < 2)
        throw Error('기존 READY 원고 패키지의 JSON 3개와 PNG 2개가 모두 보이지 않습니다.');
      for (const f of files) {
        if (!['post.json', 'review.json', 'manifest.json'].includes(f.name) && !f.name.toLowerCase().endsWith('.png')) continue;
        if (Number(f.size || 0) > 8_000_000) throw Error('파일이 8MB를 넘어 읽기 검증을 중단했습니다.');
        const bytes = await (await drive('files/' + encodeURIComponent(f.id), {alt: 'media'})).arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > 8_000_000) throw Error('패키지 파일 내용 읽기 결과가 비정상입니다.');
        await crypto.subtle.digest('SHA-256', bytes); // Read in memory; never display or upload private bytes.
      }
      status('새 OAuth 연결으로 B02 폴더 3개 메타데이터와 READY 패키지 JSON·PNG 읽기에 성공했습니다. 이 결과는 이 브라우저의 일회성 토큰에만 해당하며, GitHub Actions OAuth/refresh token과 제작 활성화는 별도 검증이 필요합니다.');
    } catch (e) { fail(e.message || '읽기 검증에 실패했습니다.'); }
    finally { busy = false; updateReadButtons(); }
  }
  async function readChild() {
    if (busy) return;
    busy = true;
    $('read-child').disabled = true;
    try {
      const c = config();
      if (!activeConfig || Object.keys(c).some(k => c[k] !== activeConfig[k]))
        throw Error('연결 중 입력값이 바뀌었습니다. 토큰을 지운 뒤 다시 시작하세요.');
      const childId = selected.get('child');
      if (!childId || !id(childId)) throw Error('READY 하위 폴더를 Picker에서 먼저 선택하세요.');
      const folder = await meta(childId); // Read-only GET, performed only after the user presses the test button.
      if (folder.id !== childId || folder.mimeType !== FOLDER || !folder.parents?.includes(c.ready))
        throw Error('선택한 폴더가 지정한 READY 바로 아래에 있는지 확인할 수 없습니다.');
      if (folder.isAppAuthorized !== true)
        throw Error('폴더를 읽었지만 앱 접근 허용 여부가 확인되지 않았습니다.');
      status('선택한 READY 하위 폴더의 직접 조회와 부모·앱 접근 확인에 성공했습니다. 내부 파일 및 GitHub Actions Refresh Token 접근은 별도 검증이 필요합니다.');
    } catch (e) { fail(e.message || '하위 폴더 읽기 검증에 실패했습니다.'); }
    finally { busy = false; updateReadButtons(); }
  }
  $('pick').addEventListener('click', startPicker);
  $('read-child').addEventListener('click', readChild);
  $('read').addEventListener('click', readSelected);
  for (const field of ['client', 'key', 'app', 'root', 'ready', 'ledger'])
    $(field).addEventListener('input', updateReadButtons);
  $('clear').addEventListener('click', () => { accessToken = null; activeConfig = null; selected.clear(); updateReadButtons(); status('이 탭의 토큰과 선택 결과를 지웠습니다.'); });
  if (location.protocol !== 'https:' || !window.isSecureContext) {
    fail('HTTPS 보안 주소에서만 실행합니다. 파일 다운로드 미리보기·제3자 HTML 뷰어에서는 실행하지 마세요.');
  } else {
    const timer = setInterval(() => { if (ready()) { clearInterval(timer); $('pick').disabled = false; status('준비됨. Google Cloud에서 허용한 본인 소유 HTTPS 주소인지 확인한 뒤 시작하세요.'); } }, 200);
    setTimeout(() => { if (!ready()) { clearInterval(timer); fail('Google Picker/GIS 로딩에 실패했습니다.'); } }, 15000);
    // The Google API loader defines gapi asynchronously.
    const load = setInterval(() => { if (window.gapi?.load) { clearInterval(load); gapi.load('picker', () => { pickerReady = true; }); } }, 100);
    setTimeout(() => clearInterval(load), 15000);
  }
})();
