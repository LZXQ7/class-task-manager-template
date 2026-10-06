Component({
  options: { addGlobalClass: true },
  properties: {
    rows: { type: Number, value: 3 },
    type: { type: String, value: 'list' },   // list | card | grid
    height: { type: Number, value: 160 }
  }
});
