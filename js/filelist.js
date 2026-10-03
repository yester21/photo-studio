/* filelist.js — 모드 페이지 공통 다중 파일 목록.
   썸네일·삭제·위/아래 재정렬을 제공하고 파일 목록이 바뀔 때 onChange를 부른다. */

let uid = 0;

export function fmtSize(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

export function createFileList({ mount, multiple = true, accept = 'image/*', onChange, reorder = false, anyType = false }) {
  const items = []; // { id, file, name, size, thumbUrl }

  const el = document.createElement('div');
  el.className = 'filelist-items';
  const empty = document.createElement('div');
  empty.className = 'filelist-empty';
  empty.textContent = '파일이 없습니다';
  mount.innerHTML = '';
  mount.appendChild(el);
  mount.appendChild(empty);

  const notify = () => {
    empty.hidden = items.length > 0;
    onChange && onChange(items);
  };

  function render() {
    el.innerHTML = '';
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = document.createElement('div');
      row.className = 'fitem';
      const img = document.createElement('img');
      img.src = it.thumbUrl;
      img.alt = '';
      if (!it.thumbUrl) img.hidden = true;
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = it.name;
      name.title = it.name;
      const size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = fmtSize(it.size);
      const btns = document.createElement('div');
      btns.className = 'fbtns';
      if (reorder) {
        const up = document.createElement('button');
        up.className = 'fbtn'; up.textContent = '↑'; up.title = '위로';
        up.disabled = i === 0;
        up.addEventListener('click', () => {
          if (it2(i, -1)) { render(); notify(); }
        });
        const down = document.createElement('button');
        down.className = 'fbtn'; down.textContent = '↓'; down.title = '아래로';
        down.disabled = i === items.length - 1;
        down.addEventListener('click', () => {
          if (it2(i, 1)) { render(); notify(); }
        });
        btns.append(up, down);
      }
      const del = document.createElement('button');
      del.className = 'fbtn del'; del.textContent = '✕'; del.title = '삭제';
      del.addEventListener('click', () => {
        items.splice(i, 1);
        render(); notify();
      });
      btns.appendChild(del);
      row.append(img, name, size, btns);
      el.appendChild(row);
    }
  }

  function it2(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return false;
    [items[i], items[j]] = [items[j], items[i]];
    return true;
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => anyType || f.type.startsWith('image/'));
    if (!files.length) return 0;
    for (const file of files) {
      if (!multiple && items.length >= 1) items.shift();
      if (anyType) {
        items.push({ id: ++uid, file, name: file.name, size: file.size, thumbUrl: '' });
        continue;
      }
      try {
        const bmp = await createImageBitmap(file);
        const tc = document.createElement('canvas');
        const s = Math.min(1, 120 / Math.max(bmp.width, bmp.height));
        tc.width = Math.max(1, Math.round(bmp.width * s));
        tc.height = Math.max(1, Math.round(bmp.height * s));
        tc.getContext('2d').drawImage(bmp, 0, 0, tc.width, tc.height);
        const thumbUrl = tc.toDataURL('image/jpeg', 0.7);
        if (bmp.close) bmp.close();
        items.push({ id: ++uid, file, name: file.name, size: file.size, thumbUrl });
      } catch {
        /* 디코딩 실패 파일은 무시 */
      }
    }
    render();
    notify();
    return files.length;
  }

  function clear() {
    items.length = 0;
    render();
    notify();
  }

  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return false;
    [items[i], items[j]] = [items[j], items[i]];
    render();
    notify();
    return true;
  }

  return {
    addFiles,
    clear,
    get files() { return items; },
  };
}

/* 모드 페이지의 "추가" 버튼 ↔ 숨은 input 연결 + 드래그앤드롭 */
export function bindAddButton(buttonId, list, { inputId, accept = 'image/*' } = {}) {
  const btn = document.getElementById(buttonId);
  let input;
  if (inputId) input = document.getElementById(inputId);
  else {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.hidden = true;
    input.dataset.for = buttonId; // 테스트·디버깅용 식별
    document.body.appendChild(input);
  }
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) list.addFiles(input.files);
    input.value = '';
  });
  return input;
}
