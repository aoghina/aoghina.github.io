This is the personal website of Andrei Oghina, hosted by [GitHub Pages](https://pages.github.com).

You can find it at [andrei.oghina.com](https://andrei.oghina.com).

```
cd ~/code
mkdir blog
cd blog
git clone git@github.com:aoghina/aoghina.github.io.git .
```

`brew install ruby`

`nano ~/.zshrc` - add:

```
# ruby - for blog
export PATH=/Users/andrei/.gem/ruby/3.2.0/bin:$PATH

if [ -d "/opt/homebrew/opt/ruby/bin" ]; then
  export PATH=/opt/homebrew/opt/ruby/bin:$PATH
  export PATH=`gem environment gemdir`/bin:$PATH
fi
```

(open new terminal tab)

`ruby --version` (should be > 3.2)

`gem install jekyll --user-install`

```
gem install jekyll-redirect-from --user-install
gem install jekyll-paginate --user-install
```

`jekyll serve`