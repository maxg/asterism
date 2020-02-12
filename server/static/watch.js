const conn = new WebSocket(`wss://${document.location.host}${document.location.pathname}`);

const starting = document.getElementById('starting').textContent;

conn.addEventListener('message', ({ data }) => {
  let change = JSON.parse(data);
  let id = '@'+change.username;
  updateItem(document.getElementById(id) || createItem(id), change);
});

function createItem(id) {
  let item = document.importNode(document.getElementById('file').content, true);
  let root = item.children[0];
  root.id = id;
  document.querySelector('#files').append(item);
  return root;
}

function updateItem(item, change) {
  let diff = Diff.diffLines(starting, change.content).map(c => {
    return c.added ? c.value : false;
  }).filter(l => l).join('...\n');
  item.querySelector('kbd').textContent = change.username;
  item.querySelector('pre').textContent = diff;
}
