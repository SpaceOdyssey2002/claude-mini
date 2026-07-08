// ==========================================
// JavaScript 常见语法示例
// ==========================================

// ---------- 1. 变量声明 ----------
let name = 'Alice'
const age = 25
var oldWay = '不推荐使用' // 函数作用域

// ---------- 2. 数据类型 ----------
const str = 'Hello World'          // 字符串
const num = 42                     // 数字
const bool = true                  // 布尔值
const n = null                     // 空
let undef                           // undefined
const sym = Symbol('unique')       // 符号
const big = 9007199254740991n      // 大整数

// ---------- 3. 数组 ----------
const fruits = ['苹果', '香蕉', '橙子']
fruits.push('葡萄')                // 末尾添加
fruits.pop()                       // 末尾删除
fruits[0]                          // 索引访问

fruits.forEach(f => console.log(f))              // 遍历
const hasApple = fruits.includes('苹果')          // 检查包含
const upper = fruits.map(f => f.toUpperCase())   // 映射转换

// ---------- 4. 对象 ----------
const person = {
  firstName: '张',
  lastName: '三',
  age: 30,
  greet() {
    return `你好，我是${this.firstName}${this.lastName}`
  },
}

// 对象解构
const { firstName, lastName } = person
console.log(person.greet())

// ---------- 5. 函数 ----------
// 普通函数
function add(a, b) {
  return a + b
}

// 箭头函数
const multiply = (a, b) => a * b

// 默认参数
const sayHi = (name = '朋友') => `你好，${name}!`

// 剩余参数
const sumAll = (...nums) => nums.reduce((a, b) => a + b, 0)

// ---------- 6. 条件判断 ----------
const score = 85
let grade

if (score >= 90) {
  grade = '优秀'
} else if (score >= 80) {
  grade = '良好'
} else {
  grade = '加油'
}

// 三元运算符
const status = score >= 60 ? '通过' : '未通过'

// ---------- 7. 循环 ----------
for (let i = 0; i < 5; i++) {
  console.log(i)
}

for (const fruit of fruits) {
  console.log(fruit)
}

for (const key in person) {
  console.log(key, person[key])
}

// ---------- 8. 模板字符串 ----------
const product = '笔记本'
const price = 4999
console.log(`商品：${product}，价格：¥${price}`)

// ---------- 9. 异步：Promise ----------
const fetchData = () => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve('数据加载完成')
    }, 1000)
  })
}

fetchData()
  .then(data => console.log(data))
  .catch(err => console.error(err))

// ---------- 10. async/await ----------
const loadData = async () => {
  try {
    const result = await fetchData()
    console.log(result)
  } catch (error) {
    console.error('出错了', error)
  }
}

loadData()

// ---------- 11. 展开运算符 ----------
const arr1 = [1, 2, 3]
const arr2 = [4, 5, 6]
const merged = [...arr1, ...arr2] // [1, 2, 3, 4, 5, 6]

const baseConfig = { timeout: 3000 }
const config = { ...baseConfig, url: '/api' }

// ---------- 12. 类 ----------
class Animal {
  constructor(name) {
    this.name = name
  }

  speak() {
    console.log(`${this.name} 发出声音`)
  }
}

class Dog extends Animal {
  speak() {
    console.log(`${this.name} 汪汪叫`)
  }
}

const dog = new Dog('旺财')
dog.speak()

// ---------- 13. Set & Map ----------
const set = new Set([1, 2, 3, 3, 2]) // Set(3) {1, 2, 3}
set.add(4)
set.has(1) // true

const map = new Map()
map.set('key1', 'value1')
map.get('key1') // 'value1'

// ---------- 14. 模块导出 ----------
export { add, multiply, person }
export default sayHi

// ---------- 15. console 调试 ----------
console.log('普通日志')
console.warn('警告信息')
console.error('错误信息')
console.table(fruits)
console.time('计时器')
// ...一些操作...
console.timeEnd('计时器')
